// Each tab's recent requests and console messages, their bodies, and waiting for a request or a load.
const { state } = require('./state');
const out = require('./output');
const { printOutput } = out;
const { clipText, regexOf, patternText, clock } = require('./util');
const { tabState } = require('./tabstate');
const { keptSession } = require('./cdp');

// Marks a request a route answered, now: the browser reports it finished only later.
function markChanged(req, status, how) {
  changedRequests.set(req, how);
  const entry = requestEntries.get(req);
  if (entry) { entry.status = `${status} ${how}`; entry.ms = Date.now() - entry.t; }
}

// Always-on request and console logs, so what happened can be checked after
// someone has already clicked through without a capture running. Requests
// keep metadata plus a handle to the response; a body is read from the
// browser only when asked for, and only while the browser still has it.
const RECENT_MAX = 200;
const RECENT_DEFAULT = 20;
const BODY_TIMEOUT = 15000;
// Hidden unless asked for: they are rarely what is being checked and crowd out
// the API calls that are.
const RECENT_HIDDEN_TYPES = new Set(['image', 'font', 'stylesheet', 'media']);
// What watch leaves out: scripts too, since a dev server loads dozens per navigation, crowding out the API calls.
const WATCH_HIDDEN_TYPES = new Set([...RECENT_HIDDEN_TYPES, 'script']);
// The bodies body prints; any other is binary.
const TEXT_BODY = /json|^text\/|javascript|xml|html|x-www-form-urlencoded/;

// UTF-8 with no control characters but tabs and line breaks.
function looksLikeText(buffer) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return false; }
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}
// A watched tab keeps each body watch shows as it arrives, since the browser
// drops them once the tab navigates, often before anyone has read them.
const KEPT_BODY_MAX = 100 * 1024;
// request -> how a route changed it (faked or patched), shown after its status.
const changedRequests = new WeakMap();
const requestEntries = new WeakMap();

// The browser's own "Failed to load resource" message does not say which one.
function consoleText(msg) {
  const text = msg.text();
  const url = msg.location()?.url;
  return /^Failed to load resource/.test(text) && url ? `${text}: ${url}` : text;
}

// A level includes the ones above it, as playwright-cli's console [min-level]
// does, which sorts the types the same way; a page error is an error.
const CONSOLE_LEVELS = ['error', 'warning', 'info', 'debug'];
const DEBUG_TYPES = new Set(['clear', 'debug', 'endGroup', 'profile', 'profileEnd', 'startGroup', 'startGroupCollapsed', 'trace']);

function consoleLevel(type) {
  if (type === 'error' || type === 'assert' || type === 'pageerror') return 'error';
  if (type === 'warning') return 'warning';
  return DEBUG_TYPES.has(type) ? 'debug' : 'info';
}

function keep(log, entry) {
  log.push(entry);
  if (log.length > RECENT_MAX) { log.shift(); log.dropped = true; }
}

// Said when a listing leaves some out, or it looks complete: a busy page makes more than the
// default in one load, and the log itself keeps only the last RECENT_MAX.
function cutNote(what, shown, total, dropped, command) {
  if (shown < total) return `(last ${shown} of ${total} kept; ${command(Math.min(total, RECENT_MAX))} shows them all${dropped ? `; older ${what} are no longer kept` : ''})`;
  return dropped ? `(older ${what} are no longer kept: only the last ${RECENT_MAX} of every kind are)` : null;
}

// A request's status as requests shows it: its response's, and how a route changed it.
function statusOf(req, res) {
  const status = res ? String(res.status()) : 'no response';
  return changedRequests.has(req) ? `${status} ${changedRequests.get(req)}` : status;
}

// opened: the tab opened while the REPL runs. One a link opens has started loading before the REPL
// sees it, so the requests it made till then are asked for and put in the log, its document among them.
function ensureRecentLog(p, opened = false) {
  if ('log' in tabState(p)) return;
  const log = [];
  const logs = [];
  let nextId = 1;
  let newDocument = false;
  tabState(p).log = log;
  tabState(p).consoleLog = logs;
  const add = (req, t) => {
    let navigation = false;
    try { navigation = req.isNavigationRequest() && req.frame() === p.mainFrame(); } catch {}
    const entry = { id: nextId++, t, method: req.method(), url: req.url(), type: req.resourceType(), status: 'pending', ms: null, response: null, navigation };
    if (navigation) newDocument = true;
    requestEntries.set(req, entry);
    keep(log, entry);
  };
  p.on('request', req => add(req, Date.now()));
  if (opened) {
    p.requests().then(async earlier => {
      const missed = earlier.filter(req => !requestEntries.has(req));
      if (!missed.length) return;
      for (const req of missed) add(req, Math.round(req.timing().startTime));
      // Numbered in the order they were made, the missed ones first: this is moments after the tab opened.
      log.sort((a, b) => a.t - b.t);
      log.forEach((entry, i) => { entry.id = i + 1; });
      nextId = log.length + 1;
      // One that finished before the REPL saw it has no event to come.
      for (const req of missed) {
        const res = await req.response().catch(() => null);
        const entry = requestEntries.get(req);
        if (!res || entry.status !== 'pending') continue;
        entry.status = statusOf(req, res);
        entry.ms = Math.max(0, Math.round(req.timing().responseEnd >= 0 ? req.timing().responseEnd : req.timing().responseStart));
        entry.response = res;
        keepBody(p, entry, res);
      }
    }).catch(() => {});
  }
  const finish = (req, status, response = null) => {
    const entry = requestEntries.get(req);
    if (!entry) return;
    entry.status = status;
    entry.ms = Date.now() - entry.t;
    entry.response = response;
  };
  p.on('requestfinished', async req => {
    let res = null;
    try { res = await req.response(); } catch {}
    finish(req, statusOf(req, res), res);
    keepBody(p, requestEntries.get(req), res);
  });
  p.on('requestfailed', async req => {
    // A page that never loaded: the app's next route change is not a load either.
    if (requestEntries.get(req)?.navigation) newDocument = false;
    const reason = req.failure()?.errorText || 'unknown';
    // Whatever its status says: wait load must know at once that this one will never load.
    const entry = requestEntries.get(req);
    if (entry) entry.failed = reason;
    // Chrome reports a response that has no body (204, 205, 304) as aborted once it has arrived: the
    // page got its answer. Any other answered one failed while its body came in, and says so.
    const res = await req.response().catch(() => null);
    if (res) {
      const status = statusOf(req, res);
      finish(req, [204, 205, 304].includes(res.status()) ? status : `${status}, then failed: ${reason}`, res);
    } else {
      finish(req, `failed: ${reason}`);
    }
  });
  p.on('load', () => { tabState(p).loadedAt = Date.now(); });
  // A page load, marked among the messages it comes between; it ages out with them. Only a new
  // document counts: an app's own route change (pushState, a hash) navigates without loading.
  p.on('framenavigated', frame => {
    if (frame !== p.mainFrame() || !newDocument) return;
    newDocument = false;
    keep(logs, { t: Date.now(), type: 'load', text: frame.url() });
  });
  p.on('console', msg => keep(logs, { t: Date.now(), type: msg.type(), text: clipText(consoleText(msg)) }));
  // Uncaught exceptions never reach the console event.
  p.on('pageerror', error => keep(logs, { t: Date.now(), type: 'pageerror', text: clipText(error.stack || error.message) }));
}

// A page that navigates as soon as a request answers (a login that redirects)
// takes the body with it before the request is even reported finished; told to
// in time, the browser keeps them outside the page instead. Once per tab, from
// its first watch, and never switched off: up to 50 MB of the browser's memory
// per watched tab, for as long as the REPL runs.
const DURABLE_TOTAL = 50 * 1024 * 1024;

async function keepBodiesDurable(p) {
  if ('bodiesDurable' in tabState(p)) return;
  tabState(p).bodiesDurable = true;
  try {
    const session = await keptSession(p);
    await session.send('Network.configureDurableMessages', { maxTotalBufferSize: DURABLE_TOTAL, maxResourceBufferSize: KEPT_BODY_MAX });
  } catch {
    // An older Chrome: bodies are still kept once their requests finish.
  }
}

async function keepBody(p, entry, res) {
  if (!entry || !res || !(tabState(p).watch?.on || 'watchStarting' in tabState(p)) || WATCH_HIDDEN_TYPES.has(entry.type)) return;
  const headers = res.headers();
  if (!TEXT_BODY.test(headers['content-type'] || '') || Number(headers['content-length']) > KEPT_BODY_MAX) return;
  try {
    const buffer = await res.body();
    if (buffer.length <= KEPT_BODY_MAX) entry.kept = buffer;
  } catch {}
}

// A pattern without * is a URL part; with * it is a glob (* within a path segment, ** across).
function urlMatcher(pattern) {
  if (!pattern.includes('*')) return url => url.includes(pattern);
  const source = pattern.split('**').map(chunk => chunk.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  const regex = new RegExp(`^${source}$`);
  return url => regex.test(url);
}

function printRequest(entry) {
  out.log(`#${entry.id} ${entry.method} ${entry.status} ${entry.url}`);
}

// Watches the recent log, which has every request from the moment it starts, so
// one that began or finished since the previous command (e.g. the click that
// caused it) is found rather than missed.
async function waitForRequest(pattern, timeout) {
  const matches = urlMatcher(pattern);
  const since = state.previousCommandAt || 0;
  const deadline = Date.now() + timeout;
  for (;;) {
    // Begun since the previous command, or finished since, or still going: one begun earlier (a
    // reload two commands ago) can still be the one waited for. A finished one first, so a request
    // that never ends (a long poll) does not hide one that has.
    const found = (tabState(state.page).log || []).filter(e => matches(e.url) && (e.t >= since || e.ms === null || e.t + e.ms >= since));
    const done = found.find(e => e.status !== 'pending');
    if (done) return printRequest(done);
    const entry = found[0];
    if (Date.now() >= deadline) throw new Error(`No response matching ${pattern} within ${timeout / 1000}s${entry ? ` (#${entry.id} is still pending)` : ''}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// Why a navigation that failed did not load, from its request.
// Its status says why once the request log has it failed; until then (pending, or its code) the reason is added.
function notLoaded(navigation) {
  const why = stayedPut(navigation) ? `${navigation.status} (no page to show, so the tab stays where it was)` : /^failed|, then failed: /.test(navigation.status) ? navigation.status : `${navigation.status}, then failed: ${navigation.failed}`;
  return `The page did not load: #${navigation.id} ${navigation.url} ${why}`;
}

// Answered with no page (204, 205): Chrome leaves the tab on the page it was on.
function stayedPut(entry) {
  return !!entry.failed && /^(?:204|205)\b/.test(entry.status);
}

// Done once the page has loaded: after the latest navigation of the tab that
// began since the previous command did (the click on a link, say), or, with
// none, the document there now. Waiting on Playwright's load state alone would
// see the page being left, which has already loaded.
async function waitForLoad(timeout) {
  const p = state.page;
  const since = state.previousCommandAt || 0;
  const deadline = Date.now() + timeout;
  for (;;) {
    const navigation = (tabState(p).log || []).filter(e => e.navigation && e.t >= since).pop();
    if (navigation?.failed && navigation.status !== 'pending') throw new Error(notLoaded(navigation));
    const loaded = navigation ? (tabState(p).loadedAt || 0) >= navigation.t : await p.evaluate(() => document.readyState === 'complete').catch(() => false);
    if (loaded && !navigation && (tabState(p).loadedAt || 0) < since) {
      // Nothing loaded since the previous command: a page that changes its URL itself (pushState) does not
      // load, and may not have changed it yet.
      out.log(`Loaded before the previous command, nothing since: ${p.url()} — ${await p.title().catch(() => '')}\n(A page that changes its own URL does not load: wait <selector> or wait text waits for its new view.)`);
      return;
    }
    if (loaded) { out.log(`Loaded: ${p.url()} — ${await p.title().catch(() => '')}`); return; }
    if (Date.now() >= deadline) throw new Error(`${p.url()} did not finish loading within ${timeout / 1000}s`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const commands = {
  async requests(args) {
    // --regex <pattern> takes the rest of the line.
    let regex = null;
    let regexArg = null;
    const text = (args || '').replace(/(?:^|\s)--regex(?:\s+([\s\S]*))?$/, (_, pattern) => {
      if (!pattern?.trim()) throw new Error('Usage: requests [--all] [n] --regex <pattern>');
      regexArg = pattern.trim();
      regex = regexOf(patternText(regexArg));
      return '';
    });
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    const everything = tokens.includes('--all');
    if (everything) tokens.splice(tokens.indexOf('--all'), 1);
    let count = RECENT_DEFAULT;
    if (tokens.length && /^\d+$/.test(tokens[0])) count = Number(tokens.shift());
    if (count < 1 || count > RECENT_MAX || tokens.length > (regex ? 0 : 1)) throw new Error(`Usage: requests [--all] [n] [url-filter | --regex <pattern>] (n from 1 to ${RECENT_MAX})`);
    const filter = regex ? String(regex) : tokens[0];
    const wanted = regex ? url => regex.test(url) : url => !filter || url.includes(filter);
    const log = tabState(state.page).log || [];
    const shown = everything ? log : log.filter(e => !RECENT_HIDDEN_TYPES.has(e.type) && !e.url.startsWith('chrome-extension://'));
    const kept = shown.filter(e => wanted(e.url));
    const matches = kept.slice(-count);
    const cut = cutNote('requests', matches.length, kept.length, log.dropped, n => `requests${everything ? ' --all' : ''} ${n}${regex ? ` --regex ${regexArg}` : filter ? ` ${filter}` : ''}`);
    // First, so the list is not read as complete, and its last line is still the latest request.
    if (cut) out.log(cut);
    if (!matches.length) { out.log(filter ? `No requests matching ${filter}` : 'No requests on the selected tab'); return; }
    // Where each page load starts, as console marks it, so the requests of one load can be told
    // apart; from the load the first one shown came from, and whether or not the filter matches it.
    // Not one answered with no page: the tab stayed on the page it was on.
    const loads = log.filter(e => e.navigation && !stayedPut(e));
    let load = loads.filter(e => e.id <= matches[0].id).pop();
    for (const e of matches) {
      for (const next of loads.filter(n => (!load || n.id > load.id) && n.id <= e.id)) load = next;
      if (load && !load.marked) out.log(`${clock(load.t)} --- the page loads ${load.url}`);
      if (load) load.marked = true;
      const ms = e.ms === null ? '-' : `${e.ms}ms`;
      out.log(`#${e.id} ${clock(e.t)} ${e.method} ${e.status} ${ms} ${e.type} ${e.url}`);
    }
    for (const e of loads) delete e.marked;
    // The numbers skip what is hidden; say so, or they look like requests went missing.
    const first = matches[0].id;
    const last = matches[matches.length - 1].id;
    // With a filter, the numbers skip what does not match too, so the count would mislead.
    const hidden = everything || filter ? 0 : log.filter(e => e.id > first && e.id < last && !shown.includes(e)).length;
    if (hidden) out.log(`(${hidden} hidden between these: images, fonts, stylesheets, media and extension requests; requests --all shows them)`);
  },

  async body(args, all) {
    const arg = (args || '').trim();
    if (!arg) throw new Error('Usage: body <#> | body <url-part> (the number from requests, or the latest request whose URL contains url-part)');
    const log = tabState(state.page).log || [];
    const match = /^#?(\d+)$/.exec(arg);
    // The latest that has finished: one still pending has no body yet.
    const entry = match ? log.find(e => e.id === Number(match[1])) : log.filter(e => e.url.includes(arg) && e.status !== 'pending').pop();
    if (!entry) throw new Error(match ? `No request #${match[1]} on the selected tab; requests lists them` : `No finished request on the selected tab has a URL containing ${arg}`);
    const id = entry.id;
    // A fake is marked answered before the browser hands over its response.
    for (let waited = 0; !entry.response && /(?:faked|patched)$/.test(entry.status) && waited < 2000; waited += 50) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!entry.response) throw new Error(`#${id} has no response${entry.status === 'pending' ? ' yet' : ` (${entry.status})`}`);
    let buffer = entry.kept;
    if (!buffer) {
      // Not withTimeout: its "timed out" error would disconnect the REPL, and
      // reading a body cannot have changed anything.
      let timer;
      const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`did not arrive within ${BODY_TIMEOUT / 1000}s`)), BODY_TIMEOUT); });
      try { buffer = await Promise.race([entry.response.body(), late]); }
      // Playwright's reason ends in advice for its own API ("Read response.body() before..."), so only its first line is kept.
      catch (error) { throw new Error(`The body of #${id} is not available: ${String(error.message).split('\n')[0]} (the browser drops bodies, e.g. after the tab navigates; a watched tab keeps them as they arrive)`); }
      finally { clearTimeout(timer); }
    }
    const type = entry.response.headers()['content-type'] || '';
    out.log(`#${id} ${entry.method} ${entry.status} ${entry.url} (${type || 'no content type'}, ${buffer.length} bytes)`);
    if (!buffer.length) return;
    // With no content type, text is told by its bytes: an error page's "not found" often has none.
    if (!TEXT_BODY.test(type) && (type || !looksLikeText(buffer))) { out.log('[binary body not shown]'); return; }
    let text = buffer.toString('utf8');
    if (/json/.test(type)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
    printOutput(text, all);
  },

  async console(args, all) {
    const tokens = (args || '').trim().split(/\s+/).filter(Boolean);
    let count = RECENT_DEFAULT;
    if (tokens.length && /^\d+$/.test(tokens[0])) count = Number(tokens.shift());
    if (count < 1 || count > RECENT_MAX || tokens.length > 1) throw new Error(`Usage: console [n] [level | filter] (n from 1 to ${RECENT_MAX})`);
    const filter = tokens[0];
    const level = CONSOLE_LEVELS.indexOf(filter);
    const shown = level === -1
      ? e => !filter || e.type.includes(filter) || e.text.includes(filter)
      : e => CONSOLE_LEVELS.indexOf(consoleLevel(e.type)) <= level;
    const logs = tabState(state.page).consoleLog || [];
    const kept = logs.filter(e => e.type !== 'load' && shown(e));
    const matches = kept.slice(-count);
    const cut = cutNote('messages', matches.length, kept.length, logs.dropped, n => `console ${n}${filter ? ` ${filter}` : ''}`);
    if (cut) out.log(cut);
    if (!matches.length) { out.log(filter ? `No console messages matching ${filter}` : 'No console messages on the selected tab'); return; }
    // Where the page loaded again, so a message from an earlier load does not read as the current one's.
    // From the load the first message shown came from, if it is still kept.
    let first = logs.indexOf(matches[0]);
    while (first > 0 && logs[first].type !== 'load') first -= 1;
    const lines = logs.filter((e, i) => i >= first && (e.type === 'load' || matches.includes(e)));
    printOutput(lines.map(e => (e.type === 'load' ? `${clock(e.t)} --- the page loaded ${e.text}` : `${clock(e.t)} [${e.type}] ${e.text}`)).join('\n'), all);
  },
};

module.exports = { commands, markChanged, RECENT_DEFAULT, RECENT_HIDDEN_TYPES, WATCH_HIDDEN_TYPES, requestEntries, consoleText, keep, ensureRecentLog, keepBodiesDurable, waitForRequest, notLoaded, stayedPut, waitForLoad };
