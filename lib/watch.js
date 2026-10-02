// Watching what someone does in a tab: each step, the requests it caused and what it changed.
const { state, clientRecord } = require('./state');
const out = require('./output');
const { printOutput } = out;
const { clipText, clock, hints, NO_TAB } = require('./util');
const { tabState } = require('./tabstate');
const { keptSession, keepDrawing } = require('./cdp');
const { RECENT_HIDDEN_TYPES, keepBodiesDurable, keep, WATCH_HIDDEN_TYPES, RECENT_DEFAULT } = require('./requestlog');
const { compactSnapshot } = require('./inspect');

// Opt-in record of what the user at the browser does, so an agent can see
// the steps and the requests each one caused. Values typed into fields are
// never recorded, and password fields not at all.
const WATCH_MAX = 200;
const WATCH_REQUESTS_SHOWN = 5;

const TYPING_BACKDATE_MAX = 60000;
const PAGE_ACTIONS = new Set(['click', 'check', 'uncheck', 'select', 'fill', 'type', 'press', 'submit']);
const WATCH_BINDING = '__pwReplWatch';

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
  // Text inside these may be what the user typed, so it is never used as a name.
  const typedInto = el => el.matches('input,select,textarea,form') || el.isContentEditable || !!el.closest('[contenteditable]:not([contenteditable=false])');
  const isPassword = el => el.matches('input[type=password]') || (el.control && el.control.matches('input[type=password]'));
  // An element holding an editable area would be named partly by what was typed there.
  const hasEditable = el => !!el.querySelector('[contenteditable]:not([contenteditable=false])');
  const clip = text => (text || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  // A label's own words, without the options or values of the controls inside it.
  const labelText = label => {
    const copy = label.cloneNode(true);
    copy.querySelectorAll('select,textarea,input,button').forEach(n => n.remove());
    return copy.textContent;
  };
  const nameOf = el => {
    const labelledBy = el.getAttribute('aria-labelledby');
    const byId = labelledBy && labelledBy.split(/\\s+/).map(id => document.getElementById(id)?.innerText).join(' ');
    const label = (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest('label');
    return clip(el.getAttribute('aria-label') || byId || (label && label !== el && labelText(label)) || el.getAttribute('alt')
      || el.getAttribute('placeholder') || el.getAttribute('title') || (typedInto(el) || hasEditable(el) ? '' : el.innerText));
  };
  const describe = el => { const name = nameOf(el); return roleOf(el) + (name ? ' ' + JSON.stringify(name) : ''); };
  // el null: the page itself, e.g. Escape with nothing focused.
  const send = (action, el, extra, since) => {
    // Typing still waiting for its pause is recorded first, so the steps stay in order.
    if (action !== 'type') for (const field of [...pending.keys()]) flushTyping(field);
    if (typeof window.__pwReplWatch === 'function') window.__pwReplWatch(JSON.stringify({ action, target: el ? describe(el) : 'page', extra: extra || '', since: since || 0 }));
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
// be what the user typed. A new or removed element is shown once, with the
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
// difference from the previous snapshot to that step. With --live, that is
// also when the step is printed, with its requests and changes.
const SETTLE_QUIET = 800;
const SETTLE_MAX = 3000;

// Text in an editable area (contenteditable) may be what the user typed,
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

function scheduleSettle(p, watch) {
  clearTimeout(watch.settleTimer);
  if (!watch.changes && !watch.live) return;
  watch.settleTimer = setTimeout(async () => {
    const step = watch.events[watch.events.length - 1];
    const deadline = Date.now() + SETTLE_MAX;
    const busy = () => (tabState(p).log || []).some(r => r.t >= step.t && r.status === 'pending' && !RECENT_HIDDEN_TYPES.has(r.type));
    while (busy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    // A newer step restarts the wait; its changes will include these.
    if (watch.events[watch.events.length - 1] !== step || p.isClosed()) return;
    if (watch.changes) {
      let text = null;
      try { text = await snapshotText(p); } catch {}
      if (watch.events[watch.events.length - 1] !== step) return;
      // Against another page, everything differs; the navigate step says enough.
      if (text !== null && step.action !== 'navigate' && watch.snapshot !== null) step.changes = summarizeChanges(watch.snapshot, text);
      if (text !== null) watch.snapshot = text;
    }
    printLive(p, watch);
  }, SETTLE_QUIET);
}

// Prints the step --live has not printed yet, above the prompt.
function printLive(p, watch) {
  const step = watch.liveStep;
  if (!step) return;
  watch.liveStep = null;
  const lines = stepLines(step, requestsByStep(watch, p)(step));
  // Named by its URL when it is not the selected tab, so a step can be placed.
  const where = p === state.page ? '' : ` ${p.url().replace(/^[a-z]+:\/\//, '').slice(0, 60)}`;
  const prefix = `[watch${where}] `;
  out.aside(lines.map((line, i) => `${i ? ' '.repeat(prefix.length) : prefix}${line}`).join('\n'));
}

async function startWatching(p, changes = false, live = false) {
  await keepBodiesDurable(p);
  let watch = tabState(p).watch;
  if (!watch) {
    // shownSeq and shownRequestId mark how far watch new has read.
    const created = { on: false, startedAt: 0, changes: false, live: false, liveStep: null, snapshot: null, settleTimer: null, events: [], nextSeq: 1, shownSeq: 0, shownRequestId: 0 };
    // since backdates a step (typing is reported once it pauses), but never to
    // before the previous step, so the page cannot reorder the record.
    const record = (action, target, extra, since = 0) => {
      if (!created.on) return;
      const previous = created.events[created.events.length - 1];
      const t = Math.max(Date.now() - Math.min(Math.max(Number(since) || 0, 0), TYPING_BACKDATE_MAX), previous ? previous.t : 0);
      const step = { seq: created.nextSeq++, t, action, target: clipText(target), extra: clipText(extra) };
      keep(created.events, step);
      // A step that has not settled yet is printed now: this one ends it.
      printLive(p, created);
      if (created.live) created.liveStep = step;
      scheduleSettle(p, created);
    };
    // The page can call the binding itself, so only the page-side actions are
    // accepted from it, as plain strings; navigations come from here. A CDP
    // binding of its own, not Playwright's exposeBinding: every Playwright
    // client shares that one, so another tool attached to the browser would
    // answer each call with a "not exposed" error thrown into the page.
    if (!('watchBinding' in tabState(p))) {
      const binding = { record: null };
      const session = await keptSession(p);
      session.on('Runtime.bindingCalled', ({ name, payload }) => {
        if (name !== WATCH_BINDING || !binding.record) return;
        let event;
        try { event = JSON.parse(payload); } catch { return; }
        if (event && PAGE_ACTIONS.has(event.action)) binding.record(event.action, String(event.target || ''), String(event.extra || ''), event.since);
      });
      // Calls are reported only to a session with Runtime on.
      await session.send('Runtime.enable');
      await session.send('Runtime.addBinding', { name: WATCH_BINDING });
      tabState(p).watchBinding = binding;
    }
    tabState(p).watchBinding.record = record;
    await p.addInitScript(WATCH_SCRIPT);
    p.on('framenavigated', frame => { if (frame === p.mainFrame()) record('navigate', frame.url(), ''); });
    // Only now: a failed first attempt must leave nothing half set up to retry against.
    tabState(p).watch = created;
    watch = created;
  } else if (!watch.on) {
    // A watch on after watch off is a new recording: the old steps would read as part of it.
    watch.events.length = 0;
    watch.shownSeq = watch.nextSeq - 1;
    watch.shownRequestId = Math.max(0, ...(tabState(p).log || []).map(r => r.id));
    watch.liveStep = null;
  }
  await p.evaluate(WATCH_SCRIPT);
  watch.changes = changes;
  watch.live = live;
  if (!live) watch.liveStep = null;
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

// Set by watch on --next-tab: the next tab to open (by anyone), or the next
// whose URL contains part, is watched from its first page and selected. Each
// new tab is watched from the moment it opens, since its first page may load
// at once; one that turns out not to be it is left as it was.
let nextTab = null;

// What watch on --next-tab waits for ({ part, changes, live, client }), or null.
function nextTabWanted() {
  return nextTab;
}

function stopWaitingForNextTab() {
  nextTab = null;
}

// The sender's own --next-tab is still waiting: the tab will be selected for it.
function waitingForMe() {
  return !!nextTab && nextTab.client === state.client;
}
const BROWSER_PAGE = /^(?:about|chrome|chrome-search|devtools|edge):/;

// Who is waiting: the client that asked, or the prompt (a sender without a name shares it).
function waiter() {
  return nextTab.client || 'the prompt';
}

function waitingText() {
  return `Waiting to watch the next tab that opens${nextTab.part ? ` with a URL containing ${nextTab.part}` : ''}`;
}

function watchNewTab(p) {
  const want = nextTab;
  tabState(p).watchStarting = true;
  keepBodiesDurable(p);
  startWatching(p, want.changes, want.live).then(() => {
    delete tabState(p).watchStarting;
    tabState(p).watch.owner = want.client;
    const onNavigate = frame => {
      if (frame !== p.mainFrame() || BROWSER_PAGE.test(frame.url())) return;
      const url = frame.url();
      p.off('framenavigated', onNavigate);
      const watch = tabState(p).watch;
      if (nextTab !== want || (want.part && !url.includes(want.part))) {
        stopWatching(p, watch);
        watch.events.length = 0;
        return;
      }
      nextTab = null;
      // Its record starts at its own page, not the new-tab page before it.
      const first = watch.events.findIndex(e => e.action === 'navigate' && e.target === clipText(url));
      if (first > 0) watch.events.splice(0, first);
      // A page that loaded before the watch was ready: its step is added, at its request's time.
      if (first < 0) {
        const request = (tabState(p).log || []).filter(e => e.navigation && e.url === url).pop();
        watch.events.unshift({ seq: watch.nextSeq++, t: request ? request.t : Date.now(), action: 'navigate', target: clipText(url), extra: '' });
      }
      // Selected for the client that asked, whoever's command runs now.
      const record = clientRecord(want.client);
      if (record.page !== p) { record.previousPage = record.page; record.page = p; }
      keepDrawing(p);
      out.notice(`Watching the new tab ${url}, now the selected tab (watch on --next-tab)`, p);
    };
    p.on('framenavigated', onNavigate);
    // Opened on its page already, as a link to a new tab does.
    if (p.url() && !BROWSER_PAGE.test(p.url())) onNavigate(p.mainFrame());
  }).catch(error => {
    delete tabState(p).watchStarting;
    out.notice(`Could not watch the new tab ${p.url()}: ${error.message}`, p);
  });
}

// For each step of a watch, the requests made between it and the next step.
function requestsByStep(watch, p = state.page) {
  const requests = (tabState(p).log || []).filter(r => !WATCH_HIDDEN_TYPES.has(r.type) && !r.url.startsWith('chrome-extension://'));
  // A page's document is requested before its navigate step, which is recorded once the page commits:
  // it is listed under that step (the next navigate to its URL), not under the step before.
  const documentStep = new Map();
  for (const r of requests) {
    const step = r.navigation && watch.events.find(e => e.action === 'navigate' && e.t >= r.t && e.target === clipText(r.url));
    if (step) documentStep.set(r, step);
  }
  return e => {
    const next = watch.events[watch.events.indexOf(e) + 1];
    return requests.filter(r => (documentStep.has(r) ? documentStep.get(r) === e : r.t >= e.t && (!next || r.t < next.t)));
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
  const extras = [watch?.changes && 'changes', watch?.live && 'live'].filter(Boolean);
  if (watch?.on) lines.push(`Watching the selected tab since ${clock(watch.startedAt)}${extras.length ? ` (${extras.join(', ')})` : ''}: ${steps ? counted : 'nothing has happened yet'}`);
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
  else if (steps) lines.push(hints([more, ['watch on [--changes] [--live]', 'record again']]));
  else lines.push(hints([['watch on', 'record clicks, typing, form changes and navigations'], ['watch on --changes', 'also record what each step changes on the page'], ['watch on --live', 'also print each step here as it happens']]));
  printOutput(lines.join('\n'), all);
}

function stopWatching(p, watch) {
  clearTimeout(watch.settleTimer);
  printLive(p, watch);
  watch.on = false;
  watch.changes = false;
  watch.live = false;
}

const commands = {
  async watch(args, all) {
    const arg = (args || '').trim();
    const watch = tabState(state.page).watch;
    const [sub, ...flags] = arg.split(/\s+/);
    const next = flags.indexOf('--next-tab');
    if (sub === 'on' && next !== -1) {
      const part = flags[next + 1] && !flags[next + 1].startsWith('--') ? flags[next + 1] : null;
      const rest = flags.filter((f, i) => i !== next && !(part && i === next + 1));
      if (!rest.every(f => f === '--changes' || f === '--live')) throw new Error('Usage: watch on [--changes] [--live] --next-tab [url-part]');
      // One wait at a time: a second client's would silently take the first's place.
      if (nextTab && nextTab.client !== state.client) throw new Error(`${waitingText()} already, for ${waiter()}: one at a time. modes shows it; that client's watch off, or modes off, stops it`);
      nextTab = { part, changes: rest.includes('--changes'), live: rest.includes('--live'), client: state.client };
      out.log(`${waitingText()}: it is watched from its first page, and selected. watch off stops waiting.`);
      return;
    }
    if (sub !== 'on' && arg !== 'off' && waitingForMe() && (!state.page || state.page.isClosed())) {
      out.log(`${waitingText()} (watch on --next-tab); it is selected once it opens, and watch then shows its steps.`);
      return;
    }
    if (sub === 'on' && flags.every(f => f === '--changes' || f === '--live')) {
      if (!state.page || state.page.isClosed()) throw new Error(NO_TAB);
      const changes = flags.includes('--changes');
      const live = flags.includes('--live');
      await startWatching(state.page, changes, live);
      tabState(state.page).watch.owner = state.client;
      out.log(`Watching the selected tab: clicks, typing, form changes, submits and navigations${changes ? ', and what each changed on screen' : ''} (typed values are not recorded)`);
      out.log(live ? 'Each step prints here once it settles; watch shows them again.' : 'watch shows what it has recorded; watch on --live also prints each step here as it happens.');
      return;
    }
    if (arg === 'off') {
      if (nextTab && nextTab.client === state.client) { nextTab = null; out.log('Stopped waiting to watch a new tab'); }
      else if (nextTab) out.log(`${waitingText()}, for ${waiter()}, is left on: watch off stops only your own`);
      if (!state.page || state.page.isClosed()) return;
      if (!watch?.on) { out.log('Not watching the selected tab.'); return; }
      stopWatching(state.page, watch);
      const steps = watch.events.length;
      out.log(`Stopped watching the selected tab${steps ? `; ${steps} step${steps === 1 ? '' : 's'} recorded (watch shows them)` : ''}`);
      return;
    }
    if (!arg) return showWatch(watch, all);
    const usage = `Usage: watch on [--changes] [--live] | watch off | watch [n] | watch new (n from 1 to ${WATCH_MAX})`;
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
};

module.exports = { commands, summarizeChanges, scrubEditable, nextTabWanted, stopWaitingForNextTab, waitingForMe, waitingText, watchNewTab, stopWatching };
