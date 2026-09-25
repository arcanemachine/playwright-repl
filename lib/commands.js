const path = require('path');
const fs = require('fs');
const { state, withTimeout, onShutdown, shutdown } = require('./state');
const out = require('./output');
const HELP = require('./help');

const { printOutput, OUTPUT_LIMIT } = out;
const SCREENSHOT_DIR = process.env.PW_SCREENSHOT_DIR || '/tmp';
const COMMAND_TIMEOUT = 15000;
const MAX_CAPTURE_EVENTS = 10000;
const MAX_CAPTURE_TEXT = 400000;
const MAX_EVENT_TEXT = 4000;

let cap = null;
let lastCapture = null;

// Records the selected tab's requests and console messages together, in time
// order, until capture off, or for a set number of seconds.
async function startCapture(tokens) {
  if (cap) { out.log('Already capturing; capture off stops it.'); return; }
  const usage = 'Usage: capture on [requests|console] [seconds] (seconds from 1 to 3600)';
  const kinds = tokens.filter(t => t === 'requests' || t === 'console');
  const numbers = tokens.filter(t => /^\d+$/.test(t));
  if (kinds.length > 1 || numbers.length > 1 || kinds.length + numbers.length !== tokens.length) throw new Error(usage);
  const seconds = numbers.length ? Number(numbers[0]) : null;
  if (seconds !== null && (seconds < 1 || seconds > 3600)) throw new Error(usage);
  const label = kinds[0] || 'requests and console';
  const startedAt = Date.now();
  const events = [];
  const handlers = [];
  let dropped = 0;
  let shortened = 0;
  let bytes = 0;
  const record = event => {
    let text = String(event.text);
    if (text.length > MAX_EVENT_TEXT) { text = `${text.slice(0, MAX_EVENT_TEXT)}…`; shortened += 1; }
    const size = text.length;
    if (events.length >= MAX_CAPTURE_EVENTS || bytes + size > MAX_CAPTURE_TEXT) { dropped += 1; return; }
    bytes += size;
    events.push({ ...event, text });
  };
  const listen = (event, handler) => { state.page.on(event, handler); handlers.push([event, handler]); };
  if (label !== 'console') listen('request', req => record({ t: Date.now(), tag: 'request', text: `${req.method()} ${req.url()}` }));
  if (label !== 'requests') {
    listen('console', msg => record({ t: Date.now(), tag: `console:${msg.type()}`, text: msg.text() }));
    listen('pageerror', error => record({ t: Date.now(), tag: 'pageerror', text: error.stack || error.message }));
  }
  cap = {
    page: state.page, label, startedAt, events, handlers,
    get dropped() { return dropped; },
    get shortened() { return shortened; },
  };
  if (seconds) {
    out.log(`Capturing ${label} for ${seconds}s...`);
    await state.page.waitForTimeout(seconds * 1000);
    stopCapture();
  } else {
    out.log(`Capturing ${label}; capture off stops it and prints what it recorded.`);
  }
}

function stopCapture(all = false) {
  if (!cap) { out.log('Not capturing.'); return; }
  cap.handlers.forEach(([event, h]) => cap.page.off(event, h));
  const { label, startedAt, events, dropped, shortened } = cap;
  cap = null;
  lastCapture = { label, startedAt, events, dropped, shortened };
  printCapture(lastCapture, all);
}

// What a command run on its own prints after its state: the commands that come next.
function hints(pairs) {
  const width = Math.max(...pairs.map(([command]) => command.length));
  return pairs.map(([command, what]) => `  ${command.padEnd(width)}  ${what}`).join('\n');
}

const dialogPages = new WeakSet();

function ensureDialogHandler(p) {
  if (dialogPages.has(p)) return;
  dialogPages.add(p);
  p.on('dialog', dialog => {
    out.notice(`Dialog [${dialog.type()}]: ${String(dialog.message()).slice(0, OUTPUT_LIMIT)}`);
    out.notice('Handle this dialog in the browser window; the triggering command is waiting.');
  });
}

const SCREENSHOT_DELAY_MAX = 60;

function nextScreenshotPath(name) {
  const filename = name ? `screenshot-${name}` : `screenshot-${Date.now()}`;
  return path.join(SCREENSHOT_DIR, `${filename}.png`);
}

// Per page: emulation applies to the page its CDP session is attached to.
const offlineSessions = new WeakMap();
// Pages whose network is cut.
const networkCut = new WeakSet();

async function setNetwork(p, on) {
  let session = offlineSessions.get(p);
  if (!session) {
    session = await p.context().newCDPSession(p);
    await session.send('Network.enable');
    offlineSessions.set(p, session);
  }
  await session.send('Network.emulateNetworkConditions', {
    offline: !on,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  if (on) networkCut.delete(p); else networkCut.add(p);
}

// page -> Map(glob -> { status, body, handler }). Playwright routes are
// registered per page, so the listing is too.
const pageRoutes = new WeakMap();
const ROUTE_PREVIEW = 80;

function routesFor(p) {
  if (!pageRoutes.has(p)) pageRoutes.set(p, new Map());
  return pageRoutes.get(p);
}

function listRoutes() {
  const routes = routesFor(state.page);
  if (!routes.size) {
    out.log('No fake responses on the selected tab.');
    out.log(hints([['route <url-glob> <status> <json-body>', 'add one']]));
    return;
  }
  out.log(`Fake responses on the selected tab (${routes.size}):`);
  const width = Math.max(...[...routes.keys()].map(glob => glob.length));
  for (const [glob, { status, body }] of routes) {
    const preview = body.length > ROUTE_PREVIEW ? `${body.slice(0, ROUTE_PREVIEW)}…` : body;
    out.log(`  ${glob.padEnd(width)}  ${status}  ${preview}`);
  }
  out.log(hints([
    ['route <url-glob> <status> <json-body>', 'add one, or replace the one for that glob'],
    ['route off <url-glob> | route off --all', 'remove'],
  ]));
}

async function removeRoutes(glob) {
  if (!glob) throw new Error('Usage: route off <url-glob> | route off --all');
  const routes = routesFor(state.page);
  const targets = glob === '--all' ? [...routes.keys()] : [glob];
  if (glob !== '--all' && !routes.has(glob)) throw new Error(`No route for ${glob} on the selected tab`);
  for (const g of targets) {
    await state.page.unroute(g, routes.get(g).handler);
    routes.delete(g);
    out.log(`Removed: ${g}`);
  }
  if (!targets.length) out.log('No fake responses on the selected tab');
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
const recentLogs = new WeakMap();
const consoleLogs = new WeakMap();
const fakedRequests = new WeakSet();
const requestEntries = new WeakMap();
// Tabs this REPL opened with tab new.
const openedTabs = new WeakSet();

function clipText(text) {
  return text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT)}…` : text;
}

function keep(log, entry) {
  log.push(entry);
  if (log.length > RECENT_MAX) log.shift();
}

function ensureRecentLog(p) {
  if (recentLogs.has(p)) return;
  const log = [];
  const logs = [];
  let nextId = 1;
  recentLogs.set(p, log);
  consoleLogs.set(p, logs);
  p.on('request', req => {
    const entry = { id: nextId++, t: Date.now(), method: req.method(), url: req.url(), type: req.resourceType(), status: 'pending', ms: null, response: null };
    requestEntries.set(req, entry);
    keep(log, entry);
  });
  const finish = (req, status, response = null) => {
    const entry = requestEntries.get(req);
    if (!entry) return;
    entry.status = status;
    entry.ms = Date.now() - entry.t;
    entry.response = response;
  };
  p.on('requestfinished', async req => {
    let status = 'no response';
    let res = null;
    try {
      res = await req.response();
      if (res) status = String(res.status());
    } catch {}
    finish(req, fakedRequests.has(req) ? `${status} faked` : status, res);
  });
  p.on('requestfailed', req => finish(req, `failed: ${req.failure()?.errorText || 'unknown'}`));
  p.on('console', msg => keep(logs, { t: Date.now(), type: msg.type(), text: clipText(msg.text()) }));
  // Uncaught exceptions never reach the console event.
  p.on('pageerror', error => keep(logs, { t: Date.now(), type: 'pageerror', text: clipText(error.stack || error.message) }));
}

// Unnamed generic nodes are layout wrappers (mostly divs): they add depth and
// nothing to read. Drop them, lift their children, and drop cursor hints.
function compactSnapshot(text) {
  const dropped = [];
  const lines = [];
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length;
    while (dropped.length && dropped[dropped.length - 1] >= indent) dropped.pop();
    if (/^- generic(?: \[[^\]]+\])*:?$/.test(line.trim())) { dropped.push(indent); continue; }
    lines.push(' '.repeat(Math.max(0, indent - 2 * dropped.length)) + line.trimStart().replace(/ \[cursor=pointer\]/g, ''));
  }
  return lines.join('\n');
}

// Opt-in record of what the person at the browser does, so an agent can see
// the steps and the requests each one caused. Values typed into fields are
// never recorded, and password fields not at all.
const watches = new WeakMap();
const WATCH_MAX = 200;
const WATCH_REQUESTS_SHOWN = 5;
// Scripts too: a dev server loads dozens per navigation, crowding out the API calls.
const WATCH_HIDDEN_TYPES = new Set([...RECENT_HIDDEN_TYPES, 'script']);
const TYPING_BACKDATE_MAX = 60000;
const PAGE_ACTIONS = new Set(['click', 'check', 'uncheck', 'select', 'fill', 'type', 'press', 'submit']);
// Playwright refuses a second binding with the same name, so a retry must not re-register it.
const watchBindings = new WeakMap();

// Runs in the page. Describes elements the way snapshot does: role and name.
const WATCH_SCRIPT = `(() => {
  if (window.__pwReplWatching) return;
  window.__pwReplWatching = true;
  const INTERACTIVE = 'a,button,input,select,textarea,summary,label,[role],[onclick],[tabindex]';
  const roleOf = el => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type))) return 'button';
    if (tag === 'input' && type === 'checkbox') return 'checkbox';
    if (tag === 'input' && type === 'radio') return 'radio';
    if (tag === 'input' || tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  };
  // Text inside these may be what the person typed, so it is never used as a name.
  const typedInto = el => el.matches('input,select,textarea,form') || el.isContentEditable || !!el.closest('[contenteditable]:not([contenteditable=false])');
  const isPassword = el => el.matches('input[type=password]') || (el.control && el.control.matches('input[type=password]'));
  // An element holding an editable area would be named partly by what was typed there.
  const hasEditable = el => !!el.querySelector('[contenteditable]:not([contenteditable=false])');
  const clip = text => (text || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  const nameOf = el => {
    const labelledBy = el.getAttribute('aria-labelledby');
    const byId = labelledBy && labelledBy.split(/\\s+/).map(id => document.getElementById(id)?.innerText).join(' ');
    const label = (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest('label');
    return clip(el.getAttribute('aria-label') || byId || (label && label !== el && label.innerText) || el.getAttribute('alt')
      || el.getAttribute('placeholder') || el.getAttribute('title') || (typedInto(el) || hasEditable(el) ? '' : el.innerText));
  };
  const describe = el => { const name = nameOf(el); return roleOf(el) + (name ? ' ' + JSON.stringify(name) : ''); };
  // el null: the page itself, e.g. Escape with nothing focused.
  const send = (action, el, extra, since) => {
    if (typeof window.__pwReplWatch === 'function') window.__pwReplWatch({ action, target: el ? describe(el) : 'page', extra: extra || '', since: since || 0 });
  };
  document.addEventListener('click', e => {
    const el = e.target.closest ? (e.target.closest(INTERACTIVE) || e.target) : e.target;
    if (!el.matches || el.matches('input[type=checkbox],input[type=radio],select') || isPassword(el)) return;
    send('click', el);
  }, true);
  // Typing is recorded once it pauses, not on change, so a typeahead's requests
  // land under the typing that caused them. A field typed into is not also
  // recorded as a fill when it loses focus.
  const TYPING_PAUSE = 600;
  const pending = new Map();
  const typed = new WeakSet();
  // Sent with how long ago the typing began, so the step is placed before the
  // requests the typing caused.
  const flushTyping = el => {
    if (!pending.has(el)) return;
    const { timer, start } = pending.get(el);
    clearTimeout(timer);
    pending.delete(el);
    typed.add(el);
    send('type', el, '', Date.now() - start);
  };
  const editable = el => el.isContentEditable ? (el.closest('[contenteditable]:not([contenteditable=false])') || el) : null;
  const textEntry = el => el.matches('textarea,input:not([type=checkbox],[type=radio],[type=button],[type=submit],[type=reset],[type=image],[type=file],[type=range],[type=color])');
  document.addEventListener('input', e => {
    const el = editable(e.target) || e.target;
    if (!el.matches || isPassword(el) || !(textEntry(el) || el.isContentEditable)) return;
    const start = pending.has(el) ? pending.get(el).start : Date.now();
    clearTimeout(pending.get(el)?.timer);
    pending.set(el, { start, timer: setTimeout(() => flushTyping(el), TYPING_PAUSE) });
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    if (!e.target.matches) return;
    const el = editable(e.target) || e.target.closest(INTERACTIVE);
    if (el && isPassword(el)) return;
    // Enter on a button or link is recorded as the click it causes.
    if (e.key === 'Enter' && !(el && (textEntry(el) || el.isContentEditable))) return;
    if (el) flushTyping(el);
    send('press', el, e.key);
  }, true);
  document.addEventListener('change', e => {
    const el = e.target;
    if (!el.matches || isPassword(el)) return;
    if (el.matches('input[type=checkbox],input[type=radio]')) return send(el.checked ? 'check' : 'uncheck', el);
    if (el.matches('select')) return send('select', el, JSON.stringify(clip(el.selectedOptions[0]?.text)));
    if (pending.has(el)) { flushTyping(el); typed.delete(el); return; }
    if (typed.has(el)) { typed.delete(el); return; }
    send('fill', el);
  }, true);
  document.addEventListener('submit', e => send('submit', e.target), true);
})()`;

// What changed on screen between two snapshots, in a few lines. Refs, links'
// URLs and focus are dropped, and so are the values of text fields, which may
// be what the person typed. A new or removed element is shown once, with the
// first few named things inside it, not line by line.
const CHANGES_SHOWN = 5;
const CHANGE_WIDTH = 100;
const CHANGE_NAMES_SHOWN = 3;
const FIELD_VALUE = /^(- (?:textbox|combobox|searchbox|spinbutton)\b[^:]*?)(?::.*)?$/;

function snapshotNodes(text) {
  const nodes = [];
  const stack = [];
  for (const line of compactSnapshot(text).split('\n')) {
    let body = line.trim().replace(/ \[ref=[^\]]+\]/g, '').replace(/ \[active\]/g, '');
    if (!body || /^- \/url:/.test(body)) continue;
    body = body.replace(FIELD_VALUE, '$1').replace(/:$/, '');
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const node = { body, indent, parent: stack.length ? stack[stack.length - 1] : null, children: [] };
    if (node.parent) node.parent.children.push(node);
    nodes.push(node);
    stack.push(node);
  }
  return nodes;
}

// Nodes of `nodes` with no match in `others`, compared by their text; each
// kept only if its parent is matched, so a new subtree counts once.
function unmatchedTops(nodes, others) {
  const counts = new Map();
  for (const o of others) counts.set(o.body, (counts.get(o.body) || 0) + 1);
  const unmatched = new Set();
  for (const n of nodes) {
    const c = counts.get(n.body);
    if (c) counts.set(n.body, c - 1); else unmatched.add(n);
  }
  return nodes.filter(n => unmatched.has(n) && !(n.parent && unmatched.has(n.parent)));
}

// role "name", without flags or text: how an element is told apart.
const identity = body => /^- ([^[:"]+?(?: "(?:[^"\\]|\\.)*")?)(?: \[|:|$)/.exec(body)?.[1] || body;

function describeSubtree(node) {
  const named = [];
  // A named element by role and name; an unnamed one by its text, if it has any.
  const label = body => /^- [^:"]+ "(?:[^"\\]|\\.)*"/.exec(body)?.[0].slice(2) || /^- [^:"]+: (.+)$/.exec(body)?.[1];
  // What is inside a named element is mostly its name again, so it is not listed.
  const walk = n => {
    for (const c of n.children) {
      const l = label(c.body);
      if (l && named.length < 50) named.push(l);
      if (!/"/.test(l || '')) walk(c);
    }
  };
  walk(node);
  let text = node.body.replace(/^- /, '');
  // The count goes first so clipping a long line cuts names, not the count.
  if (named.length > CHANGE_NAMES_SHOWN) text += ` (${named.length} named inside)`;
  if (named.length) text += `: ${named.slice(0, CHANGE_NAMES_SHOWN).join(', ')}${named.length > CHANGE_NAMES_SHOWN ? ', …' : ''}`;
  return text;
}

function summarizeChanges(beforeText, afterText) {
  const before = snapshotNodes(beforeText);
  const after = snapshotNodes(afterText);
  const added = unmatchedTops(after, before);
  const removed = unmatchedTops(before, after);
  const lines = [];
  // Same element, different flags or text: one changed line, not a remove and an add.
  for (const a of added) {
    const r = removed.find(x => identity(x.body) === identity(a.body) && x.indent === a.indent);
    if (r) { removed.splice(removed.indexOf(r), 1); lines.push(`~ ${a.body.replace(/^- /, '')}`); }
    else lines.push(`+ ${describeSubtree(a)}`);
  }
  for (const r of removed) lines.push(`- ${describeSubtree(r)}`);
  const clipped = lines.map(l => (l.length > CHANGE_WIDTH ? `${l.slice(0, CHANGE_WIDTH - 1)}…` : l));
  if (clipped.length > CHANGES_SHOWN) return [...clipped.slice(0, CHANGES_SHOWN), `… ${clipped.length - CHANGES_SHOWN} more changes`];
  return clipped;
}

// With watch on --changes: once the page settles after a step (no new step
// for a moment and none of its requests pending), snapshot it and attach the
// difference from the previous snapshot to that step.
const SETTLE_QUIET = 800;
const SETTLE_MAX = 3000;

// Text in an editable area (contenteditable) may be what the person typed,
// and the snapshot shows it as ordinary text, so it is blanked out: a line's
// text or name is dropped when it is part of an editable area's text.
async function snapshotText(p) {
  const text = await p.ariaSnapshot({ mode: 'ai', timeout: SETTLE_MAX });
  const edited = await p.evaluate(() => [...document.querySelectorAll('[contenteditable]:not([contenteditable=false])')]
    .map(el => el.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
  return scrubEditable(text, edited);
}

function scrubEditable(text, edited) {
  if (!edited.length) return text;
  const typed = part => { const t = part.replace(/\s+/g, ' ').trim(); return !!t && edited.some(e => e.includes(t) || t.includes(e)); };
  return text.split('\n').map(line => {
    let out = line.replace(/ "((?:[^"\\]|\\.)*)"/, (whole, name) => (typed(name) ? '' : whole));
    const value = /^(\s*- [^:]*?): (.+)$/.exec(out);
    if (value && typed(value[2].replace(/^"(.*)"$/, '$1'))) out = value[1];
    return out;
  }).join('\n');
}

function scheduleChanges(p, watch) {
  clearTimeout(watch.settleTimer);
  if (!watch.changes) return;
  watch.settleTimer = setTimeout(async () => {
    const step = watch.events[watch.events.length - 1];
    const deadline = Date.now() + SETTLE_MAX;
    const busy = () => (recentLogs.get(p) || []).some(r => r.t >= step.t && r.status === 'pending' && !RECENT_HIDDEN_TYPES.has(r.type));
    while (busy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    // A newer step restarts the wait; its changes will include these.
    if (watch.events[watch.events.length - 1] !== step || !watch.changes || p.isClosed()) return;
    let text;
    try { text = await snapshotText(p); } catch { return; }
    if (watch.events[watch.events.length - 1] !== step) return;
    // Against another page, everything differs; the navigate step says enough.
    if (step.action !== 'navigate' && watch.snapshot !== null) step.changes = summarizeChanges(watch.snapshot, text);
    watch.snapshot = text;
  }, SETTLE_QUIET);
}

async function startWatching(p, changes = false) {
  let watch = watches.get(p);
  if (!watch) {
    // shownSeq and shownRequestId mark how far watch new has read.
    const created = { on: false, startedAt: 0, changes: false, snapshot: null, settleTimer: null, events: [], nextSeq: 1, shownSeq: 0, shownRequestId: 0 };
    // since backdates a step (typing is reported once it pauses), but never to
    // before the previous step, so the page cannot reorder the record.
    const record = (action, target, extra, since = 0) => {
      if (!created.on) return;
      const previous = created.events[created.events.length - 1];
      const t = Math.max(Date.now() - Math.min(Math.max(Number(since) || 0, 0), TYPING_BACKDATE_MAX), previous ? previous.t : 0);
      keep(created.events, { seq: created.nextSeq++, t, action, target: clipText(target), extra: clipText(extra) });
      scheduleChanges(p, created);
    };
    // The page can call the binding itself, so only the page-side actions are
    // accepted from it, as plain strings; navigations come from here.
    if (!watchBindings.has(p)) {
      const binding = { record: null };
      await p.exposeBinding('__pwReplWatch', (_source, event) => {
        if (binding.record && event && PAGE_ACTIONS.has(event.action)) binding.record(event.action, String(event.target || ''), String(event.extra || ''), event.since);
      });
      watchBindings.set(p, binding);
    }
    watchBindings.get(p).record = record;
    await p.addInitScript(WATCH_SCRIPT);
    p.on('framenavigated', frame => { if (frame === p.mainFrame()) record('navigate', frame.url(), ''); });
    // Only now: a failed first attempt must leave nothing half set up to retry against.
    watches.set(p, created);
    watch = created;
  }
  await p.evaluate(WATCH_SCRIPT);
  watch.changes = changes;
  // The first step's changes are measured from how the page looks now. A page
  // too busy to snapshot is not a reason to fail: the step after one that
  // does snapshot is measured instead.
  watch.snapshot = null;
  if (changes) {
    try { watch.snapshot = await snapshotText(p); }
    catch { out.log('Could not snapshot the page yet; changes are shown from a later step.'); }
  }
  if (!watch.on) watch.startedAt = Date.now();
  watch.on = true;
}

// For each step of a watch, the requests made between it and the next step.
function requestsByStep(watch) {
  const requests = (recentLogs.get(state.page) || []).filter(r => !WATCH_HIDDEN_TYPES.has(r.type) && !r.url.startsWith('chrome-extension://'));
  return e => {
    const next = watch.events[watch.events.indexOf(e) + 1];
    return requests.filter(r => r.t >= e.t && (!next || r.t < next.t));
  };
}

function stepLines(e, caused, note = '', withChanges = true) {
  const lines = [`${clock(e.t)} ${e.action} ${e.target}${e.extra ? ` ${e.extra}` : ''}${note}`];
  const indent = ' '.repeat(clock(e.t).length + 1);
  for (const r of caused.slice(0, WATCH_REQUESTS_SHOWN)) lines.push(`${indent}#${r.id} ${r.method} ${r.status} ${r.url}`);
  if (caused.length > WATCH_REQUESTS_SHOWN) lines.push(`${indent}… ${caused.length - WATCH_REQUESTS_SHOWN} more (requests)`);
  if (e.changes && withChanges) for (const change of e.changes) lines.push(`${indent}${change}`);
  return lines;
}

// watch on its own: whether it is on, the last steps, and what to run next.
function showWatch(watch, all) {
  const steps = watch ? watch.events.length : 0;
  const counted = `${steps} step${steps === 1 ? '' : 's'}`;
  const lines = [];
  if (watch?.on) lines.push(`Watching the selected tab since ${clock(watch.startedAt)}${watch.changes ? ', with changes' : ''}: ${steps ? counted : 'nothing has happened yet'}`);
  else if (steps) lines.push(`Not watching the selected tab; ${counted} recorded before watch off:`);
  else lines.push('Not watching the selected tab.');
  if (steps) {
    const causedBy = requestsByStep(watch);
    const shown = watch.events.slice(-RECENT_DEFAULT);
    for (const e of shown) lines.push(...stepLines(e, causedBy(e)));
    if (steps > shown.length) lines.push(`(last ${shown.length} of ${steps})`);
  }
  const more = ['watch <n>', `the last n steps (up to ${WATCH_MAX})`];
  if (watch?.on) lines.push(hints([more, ['watch new', 'only the steps not shown by watch new yet'], ['watch off', 'stop recording']]));
  else if (steps) lines.push(hints([more, ['watch on [--changes]', 'record again']]));
  else lines.push(hints([['watch on', 'record clicks, typing, form changes and navigations'], ['watch on --changes', 'also record what each step changes on the page']]));
  printOutput(lines.join('\n'), all);
}

const WAIT_DEFAULT = 10;
const WAIT_MAX = 120;

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
    const entry = (recentLogs.get(state.page) || []).find(e => e.t >= since && matches(e.url));
    if (entry && entry.status !== 'pending') return printRequest(entry);
    if (Date.now() >= deadline) throw new Error(`No response matching ${pattern} within ${timeout / 1000}s${entry ? ` (#${entry.id} is still pending)` : ''}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const SNAPSHOT_HINT_LINES = 60;

// Each matching line (any part of it: role, name, flags such as [disabled]),
// with the named elements it sits in, so a match can be placed without the
// rest of the tree.
function grepSnapshot(text, needle) {
  const lower = needle.toLowerCase();
  const stack = [];
  const hits = [];
  const label = line => line.trim().replace(/^- /, '').replace(/:$/, '').replace(/^'(.*)'$/, '$1');
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (line.toLowerCase().includes(lower)) {
      const path = stack.filter(a => !/^generic(?: \[|$)/.test(a.label)).map(a => a.label.replace(/ \[ref=[^\]]+\]/g, ''));
      hits.push([...path, label(line)].join(' › '));
    }
    stack.push({ indent, label: label(line) });
  }
  return hits;
}

// Local time with its offset (18:16:15.721-06:00), so it reads against the
// user's clock and is still unambiguous.
function clock(t) {
  const d = new Date(t);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${zone}`;
}

function printCapture(capture, all = false) {
  const events = capture.events.map(event => ({
    elapsed: Number(((event.t - capture.startedAt) / 1000).toFixed(3)),
    tag: event.tag,
    text: event.text,
  }));
  if (events.length) printOutput(events, all);
  else out.log('Nothing captured');
  const notes = [];
  if (capture.dropped) notes.push(`${capture.dropped} event(s) omitted`);
  if (capture.shortened) notes.push(`${capture.shortened} message(s) shortened`);
  if (notes.length) out.log(`[capture limits: ${notes.join('; ')}]`);
}

function discardCapture() {
  if (!cap) return;
  cap.handlers.forEach(([event, handler]) => cap.page.off(event, handler));
  cap = null;
}

// Every tab, URL first, with * on the selected one. The numbers are what tab <index> uses.
async function listTabs() {
  const all = state.browser.contexts().flatMap(c => c.pages());
  if (state.page && !all.includes(state.page)) state.page = null;
  state.tabListing = all.slice();
  if (!all.length) { out.log('No tabs. Use tab new.'); return; }
  for (const [i, p] of all.entries()) {
    let title;
    try { title = await p.title(); } catch { title = '[title unavailable]'; }
    const marker = p === state.page ? '*' : ' ';
    // URL first on its own line: it is what distinguishes otherwise
    // identically titled tabs, and titles wrap less badly when indented.
    if (i) out.log('');
    out.log(`${marker} [${i}] ${p.url()}`);
    out.log(`        ${JSON.stringify(title)}`);
  }
}

const commands = {
  async tab(args) {
    const trimmed = (args || '').trim();
    if (!trimmed) {
      await listTabs();
      if (!state.page) out.log('\nNo tab is selected.');
      out.log(hints([
        ['tab <index|url-part>', 'select a tab'],
        ['tab new [url]', 'open a tab of your own and select it'],
        ['tab close [url-part]', 'close the selected tab, or the one whose URL contains url-part'],
      ]));
      return;
    }
    const usage = 'Usage: tab [<index> | <url-part> | new [url] | close [<url-part>]]';
    const parts = trimmed.split(/\s+/);
    const subcommand = parts.shift();
    const all = state.browser.contexts().flatMap(c => c.pages());
    // Matching on the URL, not an index, so a stale listing cannot point at someone else's tab.
    // Remembers where the REPL was, so closing a tab can go back there, but
    // only to a tab this REPL opened: the previous one may be someone else's.
    const select = p => {
      if (p !== state.page) state.previousPage = state.page;
      state.page = p;
      ensureDialogHandler(p);
    };
    const byUrl = part => {
      const matches = all.filter(p => p.url().includes(part));
      if (matches.length === 1) return matches[0];
      if (!matches.length) throw new Error(`No tab URL contains "${part}"`);
      throw new Error(`${matches.length} tabs match "${part}"; use a longer part:\n${matches.map(p => `  ${p.url()}`).join('\n')}`);
    };
    if (/^\d+$/.test(subcommand)) {
      if (parts.length) throw new Error(usage);
      const target = state.tabListing[Number(subcommand)];
      if (!target || !all.includes(target)) throw new Error('That tab is unavailable. Run tab again.');
      select(target);
      return commands.info();
    }
    if (subcommand === 'new') {
      const ctx = state.browser.contexts()[0];
      const opened = await ctx.newPage();
      openedTabs.add(opened);
      select(opened);
      const url = parts.join(' ');
      if (url) await commands.goto(url);
      else out.log('New tab created and selected');
      return listTabs();
    }
    if (subcommand === 'close') {
      const target = parts.length ? byUrl(parts.join(' ')) : state.page;
      if (!target || target.isClosed() || !all.includes(target)) throw new Error('Selected tab is unavailable. Run tab again.');
      if (all.length <= 1) throw new Error('Refusing to close the last tab');
      const url = target.url();
      const wasSelected = target === state.page;
      await target.close();
      if (wasSelected) {
        const back = state.previousPage;
        state.page = back && !back.isClosed() && openedTabs.has(back) ? back : null;
        state.previousPage = null;
      }
      out.log(`Closed ${url}${wasSelected && !state.page ? '; no tab is selected now' : ''}`);
      return listTabs();
    }
    select(byUrl(trimmed));
    return commands.info();
  },

  async goto(args) {
    if (!args) throw new Error('Usage: goto <url>');
    let url = args;
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url) && !/^(about|data|file|javascript):/i.test(url)) url = 'https://' + url;
    await state.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    out.log(`${state.page.url()} — ${await state.page.title()}`);
  },

  async back() {
    await state.page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
    out.log(`Back to: ${state.page.url()}`);
  },

  async forward() {
    await state.page.goForward({ waitUntil: 'domcontentloaded', timeout: 10000 });
    out.log(`Forward to: ${state.page.url()}`);
  },

  async reload() {
    await state.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    out.log(`Reloaded: ${state.page.url()}`);
  },

  async info() {
    out.log(`  URL:   ${state.page.url()}`);
    out.log(`  Title: ${await state.page.title()}`);
    const vp = state.page.viewportSize();
    if (vp) out.log(`  Viewport: ${vp.width}x${vp.height}`);
  },

  async click(args) {
    if (!args) throw new Error('Usage: click <selector>');
    await state.page.click(args, { timeout: 5000 });
    out.log(`Clicked: ${args}`);
  },

  async dblclick(args) {
    if (!args) throw new Error('Usage: dblclick <selector>');
    await state.page.dblclick(args, { timeout: 5000 });
    out.log(`Double-clicked: ${args}`);
  },

  async hover(args) {
    if (!args) throw new Error('Usage: hover <selector>');
    await state.page.hover(args, { timeout: 5000 });
    out.log(`Hovered: ${args}`);
  },

  async fill(args) {
    if (!args || !args.includes('=>')) {
      throw new Error('Usage: fill <selector> => <value>');
    }
    const [selector, ...rest] = args.split('=>');
    await state.page.fill(selector.trim(), rest.join('=>').trim(), { timeout: 5000 });
    out.log(`Filled: ${selector.trim()}`);
  },

  async type(args) {
    if (!args || !args.includes('=>')) {
      throw new Error('Usage: type <selector> => <text>');
    }
    const [selector, ...rest] = args.split('=>');
    await state.page.type(selector.trim(), rest.join('=>').trim(), { timeout: 5000 });
    out.log(`Typed into: ${selector.trim()}`);
  },

  async press(args) {
    if (!args) throw new Error('Usage: press <key> or press <selector> => <key>');
    if (args.includes('=>')) {
      const [selector, key] = args.split('=>').map(s => s.trim());
      await state.page.press(selector, key, { timeout: 5000 });
      out.log(`Pressed ${key} on ${selector}`);
    } else {
      await state.page.keyboard.press(args.trim());
      out.log(`Pressed: ${args.trim()}`);
    }
  },


  async select(args) {
    if (!args || !args.includes('=>')) {
      throw new Error('Usage: select <selector> => <value>');
    }
    const [selector, value] = args.split('=>').map(s => s.trim());
    await state.page.selectOption(selector, value, { timeout: 5000 });
    out.log(`Selected "${value}" in ${selector}`);
  },

  async check(args) {
    if (!args) throw new Error('Usage: check <selector>');
    await state.page.check(args, { timeout: 5000 });
    out.log(`Checked: ${args}`);
  },

  async uncheck(args) {
    if (!args) throw new Error('Usage: uncheck <selector>');
    await state.page.uncheck(args, { timeout: 5000 });
    out.log(`Unchecked: ${args}`);
  },

  async text(args, all) {
    if (!args) throw new Error('Usage: text <selector>');
    printOutput(await state.page.innerText(args, { timeout: 5000 }), all);
  },

  async html(args, all) {
    if (!args) throw new Error('Usage: html <selector>');
    printOutput(await state.page.$eval(args, el => el.outerHTML), all);
  },

  async attrs(args, all) {
    if (!args) throw new Error('Usage: attrs <selector>');
    const result = await state.page.$eval(args, el => {
      const out = {};
      for (const attr of el.attributes) out[attr.name] = attr.value;
      return out;
    });
    printOutput(result, all);
  },

  async count(args) {
    if (!args) throw new Error('Usage: count <selector>');
    const els = await state.page.$$(args);
    out.log(`${els.length} element(s)`);
  },

  async visible(args) {
    if (!args) throw new Error('Usage: visible <selector>');
    const el = await state.page.$(args);
    if (!el) { out.log('Not found'); return; }
    out.log(await el.isVisible() ? 'visible' : 'hidden');
  },

  async links(_args, all) {
    const links = await state.page.$$eval('a[href]', els =>
      els.map(e => ({ text: e.textContent.trim(), href: e.href }))
        .filter(l => l.text)
    );
    if (!links.length) { out.log('No links found'); return; }
    printOutput(links, all);
  },

  async inputs(_args, all) {
    const inputs = await state.page.$$eval('input, select, textarea', els =>
      els.map(e => ({
        tag: e.tagName.toLowerCase(),
        type: e.type || '',
        name: e.name || '',
        id: e.id || '',
        placeholder: e.placeholder || '',
        disabled: e.disabled,
        autocomplete: e.autocomplete || ''
      }))
    );
    if (!inputs.length) { out.log('No inputs found'); return; }
    printOutput(inputs, all);
  },

  async screenshot(args) {
    const usage = 'Usage: screenshot [--full] [--delay|-d <seconds>] [name]\nNames may contain letters, digits, underscores, and hyphens.';
    const tokens = (args || '').trim().split(/\s+/).filter(Boolean);
    let full = false;
    let delay = 0;
    const names = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '--full') { full = true; continue; }
      if (token === '--delay' || token === '-d') {
        const value = tokens[++i];
        // Capped low on purpose: a timed shot is human-in-the-loop, and a typo
        // like `-d 300` would otherwise park the serialized command queue.
        if (!value || !/^\d+$/.test(value) || Number(value) > SCREENSHOT_DELAY_MAX) throw new Error(`Usage: screenshot --delay <seconds> (maximum ${SCREENSHOT_DELAY_MAX})`);
        delay = Number(value);
        continue;
      }
      names.push(token);
    }
    if (names.length > 1 || (names[0] && !/^[a-zA-Z0-9_-]+$/.test(names[0]))) throw new Error(usage);
    const name = names[0] || null;
    // Counted down out loud so a watcher can time a hover or menu state, and so
    // the wait is distinguishable from a hung command in a tmux capture.
    for (let remaining = delay; remaining > 0; remaining--) {
      out.log(`${remaining}...`);
      await state.page.waitForTimeout(1000);
    }
    // Named after the countdown so a default filename timestamps the capture.
    const filepath = nextScreenshotPath(name);
    const image = await state.page.screenshot({ fullPage: full });
    try {
      fs.writeFileSync(filepath, image, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Screenshot already exists: ${filepath}`);
      throw error;
    }
    out.log(`Saved: ${filepath}`);
  },

  async snapshot(args, all) {
    let rest = (args || '').trim();
    const full = /^--full(?:\s|$)/.test(rest);
    if (full) rest = rest.slice(6).trim();
    let needle = null;
    if (/^--grep(?:\s|$)/.test(rest)) {
      needle = rest.slice(6).trim().replace(/^(["'])(.*)\1$/, '$2').replace(/\\"/g, '"');
      if (!needle) throw new Error('Usage: snapshot [--full] --grep <text>');
      rest = '';
    }
    // Playwright's labels are e5, or frame-prefixed like f1e5 in newer versions.
    const selector = /^(?:f\d+)?e\d+$/.test(rest) ? `aria-ref=${rest}` : rest;
    const target = selector ? state.page.locator(selector).first() : state.page;
    const raw = await target.ariaSnapshot({ mode: 'ai', timeout: 5000 });
    const text = full ? raw : compactSnapshot(raw);
    if (needle !== null) {
      const hits = grepSnapshot(text, needle);
      if (!hits.length) { out.log(`No snapshot lines match ${needle}`); return; }
      printOutput(hits.join('\n'), all);
      return;
    }
    const lines = text.split('\n').length;
    printOutput(lines > SNAPSHOT_HINT_LINES ? `${text}\n[${lines} lines; snapshot --grep <text> or snapshot <eN> shows less]` : text, all);
  },

  async viewport(args) {
    if (!args) {
      const vp = state.page.viewportSize();
      out.log(vp ? `${vp.width}x${vp.height}` : 'No viewport set');
      return;
    }
    const [w, h] = args.split('x').map(Number);
    if (!w || !h) throw new Error('Usage: viewport <width>x<height>');
    await state.page.setViewportSize({ width: w, height: h });
    out.log(`Viewport set to ${w}x${h}`);
  },

  async wait(args) {
    const usage = 'Usage: wait <selector> | wait text <text> | wait request <url-part|glob>, each with optional [seconds]';
    let tokens = (args || '').trim().split(/\s+/).filter(Boolean);
    let seconds = WAIT_DEFAULT;
    if (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1])) seconds = Number(tokens.pop());
    if (!tokens.length || seconds < 1 || seconds > WAIT_MAX) throw new Error(`${usage} (1-${WAIT_MAX})`);
    const timeout = seconds * 1000;
    const kind = tokens[0];
    if ((kind === 'text' || kind === 'request') && tokens.length > 1) {
      const what = tokens.slice(1).join(' ').replace(/^(["'])(.*)\1$/, '$2').replace(/\\"/g, '"');
      if (kind === 'text') {
        await state.page.getByText(what).first().waitFor({ state: 'visible', timeout });
        out.log(`Visible: ${what}`);
        return;
      }
      return waitForRequest(what, timeout);
    }
    const selector = tokens.join(' ');
    await state.page.waitForSelector(selector, { state: 'attached', timeout });
    out.log(`Found: ${selector}`);
  },

  async sleep(args) {
    if (!args || !/^\d+$/.test(args) || Number(args) > 3600000) throw new Error('Usage: sleep <ms> (maximum 3600000)');
    await state.page.waitForTimeout(Number(args));
    out.log(`Slept ${args}ms`);
  },

  // A stopped upstream does not reach the browser as a failure: the dev proxy
  // holds the request open instead of refusing it. Cutting the connection at
  // the browser is what a visitor's wifi or VPN dropping looks like to the page.
  // The CDP session is kept alive because emulation resets when it detaches.
  async network(args) {
    const arg = (args || '').trim().toLowerCase();
    if (!arg) {
      if (networkCut.has(state.page)) {
        out.log('The selected tab\'s network is off (offline).');
        out.log(hints([['network on', 'restore it']]));
      } else {
        out.log('The selected tab\'s network is on.');
        out.log(hints([['network off', 'cut it, like dropped wifi']]));
      }
      return;
    }
    if (arg !== 'on' && arg !== 'off') throw new Error('Usage: network [on|off]');
    await setNetwork(state.page, arg === 'on');
    out.log(`The selected tab's network is ${arg}`);
  },

  // Fulfilled inside the browser, so the page's own code handles the fake
  // exactly as a real response and the request never reaches the network.
  async route(args) {
    const trimmed = (args || '').trim();
    if (!trimmed) return listRoutes();
    const off = /^off(?:\s+(\S+))?$/.exec(trimmed);
    if (off) return removeRoutes(off[1]);
    const match = /^(\S+)\s+(\d{3})\s+([\s\S]+)$/.exec(trimmed);
    if (!match) throw new Error('Usage: route <url-glob> <status> <json-body> | route off <url-glob>|--all');
    const [, glob, statusText, body] = match;
    const status = Number(statusText);
    if (status < 200 || status > 599) throw new Error('Status must be from 200 to 599');
    try { JSON.parse(body); } catch (error) { throw new Error(`Body is not valid JSON: ${error.message}`); }
    const routes = routesFor(state.page);
    const previous = routes.get(glob);
    if (previous) await state.page.unroute(glob, previous.handler);
    const handler = async r => {
      const req = r.request();
      fakedRequests.add(req);
      try {
        await r.fulfill({ status, contentType: 'application/json', body });
        // Recorded now: the browser reports the request finished only later.
        const entry = requestEntries.get(req);
        if (entry) { entry.status = `${status} faked`; entry.ms = Date.now() - entry.t; }
        const id = entry?.id;
        out.notice(`Faked: ${id ? `#${id} ` : ''}${req.method()} ${req.url()} -> ${status}`);
      } catch (error) {
        // Aborted, never continued: a request meant to be faked must not reach the network.
        await r.abort().catch(() => {});
        const id = requestEntries.get(req)?.id;
        out.notice(`Fake failed: ${id ? `#${id} ` : ''}${req.method()} ${req.url()} — ${error.message}; the request was aborted`);
      }
    };
    await state.page.route(glob, handler);
    routes.set(glob, { status, body, handler });
    out.log(`${previous ? 'Replaced' : 'Routed'}: ${glob} -> ${status}`);
  },

  async requests(args) {
    const tokens = (args || '').trim().split(/\s+/).filter(Boolean);
    const everything = tokens.includes('--all');
    if (everything) tokens.splice(tokens.indexOf('--all'), 1);
    let count = RECENT_DEFAULT;
    if (tokens.length && /^\d+$/.test(tokens[0])) count = Number(tokens.shift());
    if (count < 1 || count > RECENT_MAX || tokens.length > 1) throw new Error(`Usage: requests [--all] [n] [url-filter] (n from 1 to ${RECENT_MAX})`);
    const filter = tokens[0];
    const log = recentLogs.get(state.page) || [];
    const shown = everything ? log : log.filter(e => !RECENT_HIDDEN_TYPES.has(e.type) && !e.url.startsWith('chrome-extension://'));
    const matches = shown.filter(e => !filter || e.url.includes(filter)).slice(-count);
    if (!matches.length) { out.log(filter ? `No requests matching ${filter}` : 'No requests on the selected tab'); return; }
    for (const e of matches) {
      const ms = e.ms === null ? '-' : `${e.ms}ms`;
      out.log(`#${e.id} ${clock(e.t)} ${e.method} ${e.status} ${ms} ${e.url}`);
    }
  },

  async body(args, all) {
    const match = /^#?(\d+)$/.exec((args || '').trim());
    if (!match) throw new Error('Usage: body <#> (the number from requests)');
    const id = Number(match[1]);
    const entry = (recentLogs.get(state.page) || []).find(e => e.id === id);
    if (!entry) throw new Error(`No request #${id} on the selected tab; requests lists them`);
    // A fake is marked answered before the browser hands over its response.
    for (let waited = 0; !entry.response && /faked$/.test(entry.status) && waited < 2000; waited += 50) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!entry.response) throw new Error(`#${id} has no response${entry.status === 'pending' ? ' yet' : ` (${entry.status})`}`);
    // Not withTimeout: its "timed out" error would disconnect the REPL, and
    // reading a body cannot have changed anything.
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`did not arrive within ${BODY_TIMEOUT / 1000}s`)), BODY_TIMEOUT); });
    let buffer;
    try { buffer = await Promise.race([entry.response.body(), late]); }
    catch (error) { throw new Error(`The body of #${id} is not available: ${error.message}`); }
    finally { clearTimeout(timer); }
    const type = entry.response.headers()['content-type'] || '';
    out.log(`#${id} ${entry.method} ${entry.status} ${entry.url} (${type || 'no content type'}, ${buffer.length} bytes)`);
    if (!buffer.length) return;
    if (!/json|^text\/|javascript|xml|html|x-www-form-urlencoded/.test(type)) { out.log('[binary body not shown]'); return; }
    let text = buffer.toString('utf8');
    if (/json/.test(type)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
    printOutput(text, all);
  },

  async console(args, all) {
    const tokens = (args || '').trim().split(/\s+/).filter(Boolean);
    let count = RECENT_DEFAULT;
    if (tokens.length && /^\d+$/.test(tokens[0])) count = Number(tokens.shift());
    if (count < 1 || count > RECENT_MAX || tokens.length > 1) throw new Error(`Usage: console [n] [filter] (n from 1 to ${RECENT_MAX})`);
    const filter = tokens[0];
    const matches = (consoleLogs.get(state.page) || [])
      .filter(e => !filter || e.type.includes(filter) || e.text.includes(filter))
      .slice(-count);
    if (!matches.length) { out.log(filter ? `No console messages matching ${filter}` : 'No console messages on the selected tab'); return; }
    printOutput(matches.map(e => `${clock(e.t)} [${e.type}] ${e.text}`).join('\n'), all);
  },

  async watch(args, all) {
    const arg = (args || '').trim();
    const watch = watches.get(state.page);
    if (arg === 'on' || arg === 'on --changes') {
      const changes = arg === 'on --changes';
      await startWatching(state.page, changes);
      out.log(`Watching the selected tab: clicks, typing, form changes, submits and navigations${changes ? ', and what each changed on screen' : ''} (typed values are not recorded)`);
      return;
    }
    if (arg === 'off') {
      if (watch) { watch.on = false; watch.changes = false; clearTimeout(watch.settleTimer); }
      out.log('Stopped watching the selected tab');
      return;
    }
    if (!arg) return showWatch(watch, all);
    const usage = `Usage: watch on [--changes] | watch off | watch [n] | watch new (n from 1 to ${WATCH_MAX})`;
    const onlyNew = arg === 'new';
    if (arg && !onlyNew && !/^\d+$/.test(arg)) throw new Error(usage);
    const count = onlyNew ? RECENT_DEFAULT : Number(arg);
    if (count < 1 || count > WATCH_MAX) throw new Error(usage);
    if (!watch || !watch.events.length) { out.log(watch?.on ? 'Watching; nothing has happened yet' : 'Not watching the selected tab; watch on starts it'); return; }
    const causedBy = requestsByStep(watch);
    const lines = [];
    const printStep = (e, caused, note = '') => {
      lines.push(...stepLines(e, caused, note, !(onlyNew && e.changesShown)));
      if (onlyNew && e.changes) e.changesShown = true;
    };
    let events;
    if (onlyNew) {
      // Requests and changes can arrive after their step was read; they are shown under it again.
      const lastShown = watch.events.find(e => e.seq === watch.shownSeq);
      const late = lastShown ? causedBy(lastShown).filter(r => r.id > watch.shownRequestId) : [];
      const lateChanges = lastShown?.changes && !lastShown.changesShown;
      if (late.length || lateChanges) printStep(lastShown, late, ' (continued)');
      events = watch.events.filter(e => e.seq > watch.shownSeq);
      if (!events.length && !late.length && !lateChanges) lines.push('No new steps');
    } else {
      events = watch.events.slice(-count);
    }
    for (const e of events) printStep(e, causedBy(e));
    // Only watch new keeps track of what has been read.
    if (onlyNew) {
      const last = watch.events[watch.events.length - 1];
      watch.shownSeq = last.seq;
      watch.shownRequestId = Math.max(watch.shownRequestId, ...causedBy(last).map(r => r.id));
    }
    if (!watch.on) lines.push('[watch is off]');
    printOutput(lines.join('\n'), all);
  },

  async eval(args, all) {
    if (!args) throw new Error('Usage: eval <js-expression>');
    printOutput(await withTimeout(state.page.evaluate(args), 'Page evaluation', COMMAND_TIMEOUT), all);
  },

  async cdp(args, all) {
    const match = /^(\S+)\s+([\s\S]+)$/.exec(args || '');
    if (!match) throw new Error('Usage: cdp <method> <JSON object>');
    if (['Browser.close', 'Target.closeTarget'].includes(match[1])) throw new Error('Browser lifecycle commands are reserved; use quit or tab close.');
    const params = JSON.parse(match[2]);
    if (!params || Array.isArray(params) || typeof params !== 'object') throw new Error('Parameters must be a JSON object');
    const operation = async () => {
      const cdp = await state.page.context().newCDPSession(state.page);
      try {
        return await cdp.send(match[1], params);
      } finally {
        await cdp.detach().catch(() => {});
      }
    };
    printOutput(await withTimeout(operation(), 'CDP operation', COMMAND_TIMEOUT), all);
  },

  async cookies(_args, all) {
    const cookies = await state.page.context().cookies();
    if (!cookies.length) { out.log('No cookies'); return; }
    printOutput(cookies.map(({ name, domain, path, expires, httpOnly, secure, sameSite }) =>
      ({ name, domain, path, expires, httpOnly, secure, sameSite })), all);
  },

  async storage(_args, all) {
    const keys = await state.page.evaluate(() =>
      Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    );
    if (!keys.length) { out.log('localStorage is empty'); return; }
    printOutput(keys, all);
  },

  async capture(args, all) {
    const [sub, ...rest] = (args || '').trim().split(/\s+/).filter(Boolean);
    if (sub === 'on') return startCapture(rest);
    if (sub === 'off' && !rest.length) return stopCapture(all);
    if (sub) throw new Error('Usage: capture on [requests|console] [seconds] | capture off');
    if (cap) {
      out.log(`Capturing ${cap.label} on ${cap.page.url()} since ${clock(cap.startedAt)} (${cap.events.length} so far)`);
      out.log(hints([['capture off', 'stop and print what it recorded']]));
      return;
    }
    if (lastCapture) {
      out.log(`Not capturing. The last capture, of ${lastCapture.label} from ${clock(lastCapture.startedAt)}:`);
      printCapture(lastCapture, all);
    } else {
      out.log('Not capturing.');
    }
    out.log(hints([['capture on [requests|console] [seconds]', 'record the selected tab\'s requests and console messages in time order']]));
  },

  async help(args) {
    const topic = (args || '').trim();
    const text = HELP.render(topic);
    if (text === null) throw new Error(`No help for ${topic}. Topics: ${Object.keys(HELP.TOPICS).join(', ')}`);
    out.log(text);
  },

  async quit() {
    out.log('Disconnecting...');
    await shutdown();
  }
};

onShutdown(discardCapture);

// Hooks every page needs from the moment the REPL sees it.
function watchPage(p) {
  ensureDialogHandler(p);
  ensureRecentLog(p);
}

// Tab completion for the prompt: command names first, then the fixed words
// a few commands take.
function complete(line) {
  const words = line.split(/\s+/);
  const current = words[words.length - 1];
  const match = options => {
    options = [...new Set(options)];
    const hits = options.filter(o => o.startsWith(current));
    return [hits.length ? hits : options, current];
  };
  if (words.length === 1) return match(Object.keys(commands).sort());
  const command = words[0];
  if (words.length === 2) {
    if (command === 'help') return match(['--all', ...Object.keys(HELP.TOPICS), ...Object.keys(HELP.COMMANDS).sort()]);
    if (command === 'tab') return match(['new', 'close']);
    if (command === 'network') return match(['on', 'off']);
    if (command === 'watch') return match(['on', 'off', 'new', '--all']);
    if (command === 'capture') return match(['on', 'off']);
    if (command === 'route') return match(['off']);
  }
  if (words.length === 3 && command === 'watch' && words[1] === 'on') return match(['--changes']);
  if (words.length === 3 && command === 'capture' && words[1] === 'on') return match(['requests', 'console']);
  if (words.length === 3 && command === 'route' && words[1] === 'off') return match(['--all', ...(state.page ? routesFor(state.page).keys() : [])]);
  return [[], current];
}

module.exports = { commands, listTabs, watchPage, complete, compactSnapshot, grepSnapshot, summarizeChanges, scrubEditable, clock };
