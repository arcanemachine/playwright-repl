const path = require('path');
const fs = require('fs');
const { state, clientRecord, shutdown } = require('./state');
const out = require('./output');
const HELP = require('./help');
const { hints, clipText, clock } = require('./util');
const { tabState } = require('./tabstate');
const { keptSession, keepDrawing } = require('./cdp');
const { commands: dialogsCommands, ensureDialogHandler, dialogCommand } = require('./dialogs');
const { commands: elementsCommands } = require('./elements');
const { commands: requestlogCommands, RECENT_DEFAULT, RECENT_HIDDEN_TYPES, WATCH_HIDDEN_TYPES, keep, ensureRecentLog, keepBodiesDurable, notLoaded, stayedPut } = require('./requestlog');
const { commands: routesCommands, routesFor, unroute } = require('./routes');
const { commands: networkCommands, setNetwork } = require('./network');
const { commands: emulationCommands, viewportText, EMULATE_KINDS, emulatedKinds, setEmulation } = require('./emulation');
const { commands: captureCommands, currentCapture, endCapture } = require('./capture');
const { commands: inspectCommands, compactSnapshot, grepSnapshot } = require('./inspect');

const { printOutput } = out;

// A navigation that does not load is said as wait load says it, from its request, rather than as
// Playwright's net:: error and call log.
async function navigating(go) {
  const started = Date.now();
  try {
    return await go();
  } catch (error) {
    if (!/net::ERR_/.test(error.message)) throw error;
    const find = () => (tabState(state.page).log || []).filter(e => e.navigation && e.t >= started && e.failed && e.status !== 'pending').pop();
    for (let waited = 0; !find() && waited < 1000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
    const navigation = find();
    if (!navigation) throw error;
    throw new Error(notLoaded(navigation));
  }
}

// A page restored from the back/forward cache never fires its load events
// again, so back and forward wait only for the navigation, then briefly for
// the document to be parsed, which a restored one already is.
async function historyStep(go, direction) {
  const before = state.page.url();
  const response = await navigating(go);
  if (response === null && state.page.url() === before) throw new Error(`No page to go ${direction} to`);
  await state.page.waitForFunction(() => document.readyState !== 'loading', null, { timeout: 3000 }).catch(() => {});
}

// The tab the REPL opened for its start URL, which tab marks: in a kept profile it sits among restored tabs.
function markStartTab(p) {
  tabState(p).start = true;
}

// Opt-in record of what the person at the browser does, so an agent can see
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
  // Text inside these may be what the person typed, so it is never used as a name.
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
// difference from the previous snapshot to that step. With --live, that is
// also when the step is printed, with its requests and changes.
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
      out.notice(`Watching the new tab ${url}, now the selected tab (watch on --next-tab)`);
    };
    p.on('framenavigated', onNavigate);
    // Opened on its page already, as a link to a new tab does.
    if (p.url() && !BROWSER_PAGE.test(p.url())) onNavigate(p.mainFrame());
  }).catch(error => {
    delete tabState(p).watchStarting;
    out.notice(`Could not watch the new tab ${p.url()}: ${error.message}`);
  });
}

// For each step of a watch, the requests made between it and the next step.
function requestsByStep(watch, p = state.page) {
  const requests = (tabState(p).log || []).filter(r => !WATCH_HIDDEN_TYPES.has(r.type) && !r.url.startsWith('chrome-extension://'));
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

// The modes turned on in a tab, in the order the prompt shows them.
function activeModes(p) {
  const modes = [];
  if (tabState(p).watch?.on) modes.push('watch');
  const network = tabState(p).network;
  if (network) modes.push(network.offline ? 'network:off' : 'network:slow');
  const emulated = emulatedKinds(tabState(p).emulation);
  if (emulated.length) modes.push(`emulate:${emulated.join(',')}`);
  const routes = tabState(p).routes?.size;
  if (routes) modes.push(`routes:${routes}`);
  if (currentCapture()?.page === p) modes.push('capture');
  return modes;
}

function listModes() {
  const all = state.browser.contexts().flatMap(c => c.pages());
  state.tabListing = all.slice();
  const on = all.map((p, i) => [p, i, activeModes(p)]).filter(([, , modes]) => modes.length);
  const want = nextTabWanted();
  if (want) out.log(`${waitingText()} (watch off stops waiting)${want.client ? `, for ${want.client}` : ''}${on.length ? '\n' : ''}`);
  if (!on.length && want) return;
  if (!on.length) {
    out.log('No modes are on in any tab.');
    out.log(hints([
      ['watch on', 'record what the person at the browser does'],
      ['capture on', 'record requests and console messages together'],
      ['route <url-glob> <status> <json-body>', 'fake a response'],
      ['network off', 'cut the tab\'s network'],
      ['emulate mobile', 'show the tab as a phone would'],
    ]));
    return;
  }
  const width = Math.max(...on.map(([p, i]) => `[${i}] ${p.url()}`.length));
  for (const [p, i, modes] of on) {
    out.log(`${p === state.page ? '*' : ' '} ${`[${i}] ${p.url()}`.padEnd(width)}  (${modes.join(' ')})`);
    const owners = modeOwners(p);
    if (owners.some(([owner]) => owner)) out.log(`      on by ${ownersText(owners)}`);
  }
  out.log(hints([['modes off', 'turn them all off']]));
}

// Who turned on each mode in a tab: [client, what], client null for the prompt or an unnamed sender.
function modeOwners(p) {
  const owners = [];
  const watch = tabState(p).watch;
  if (watch?.on) owners.push([watch.owner ?? null, 'watch']);
  const network = tabState(p).network;
  if (network) owners.push([network.owner ?? null, network.offline ? 'network:off' : 'network:slow']);
  const emulated = tabState(p).emulation;
  if (emulated) owners.push([emulated.owner ?? null, 'emulate']);
  for (const [glob, route] of tabState(p).routes || []) owners.push([route.owner ?? null, `route ${glob}`]);
  const capture = currentCapture();
  if (capture?.page === p) owners.push([capture.owner ?? null, 'capture']);
  return owners;
}

function ownersText(owners) {
  const byOwner = new Map();
  for (const [owner, what] of owners) byOwner.set(owner, [...(byOwner.get(owner) || []), what]);
  return [...byOwner].map(([owner, whats]) => `${owner || 'unnamed'}: ${whats.join(', ')}`).join('; ');
}

// Turns off everything the REPL turned on, in every tab: nothing it leaves
// behind keeps acting on someone's browser. mine: only what the running client turned on.
async function allModesOff(mine = false) {
  const all = state.browser.contexts().flatMap(c => c.pages());
  const ours = owner => !mine || (owner ?? null) === state.client;
  let any = false;
  let failed = 0;
  const want = nextTabWanted();
  if (want && ours(want.client)) { stopWaitingForNextTab(); any = true; out.log('Stopped waiting to watch a new tab'); }
  // A tab that fails (e.g. it crashed) must not keep the others' modes on.
  for (const p of all) {
    const done = [];
    let problem = null;
    try {
      const watch = tabState(p).watch;
      if (watch?.on && ours(watch.owner)) { stopWatching(p, watch); done.push('watch off'); }
      const capture = currentCapture();
      if (capture?.page === p && ours(capture.owner)) { endCapture(); done.push('capture off (capture shows it)'); }
      const globs = [...(tabState(p).routes || [])].filter(([, route]) => ours(route.owner)).map(([glob]) => glob);
      if (globs.length) { await unroute(p, globs); done.push(`${globs.length} route${globs.length === 1 ? '' : 's'} removed`); }
      if ('network' in tabState(p) && ours(tabState(p).network.owner)) { await setNetwork(p, null); done.push('network on'); }
      if ('emulation' in tabState(p) && ours(tabState(p).emulation.owner)) { await setEmulation(p, {}); done.push('emulate off'); }
    } catch (error) {
      problem = error.message;
    }
    if (done.length) { any = true; out.log(`${p.url()}: ${done.join(', ')}`); }
    if (problem) { failed += 1; out.error(`${p.url()}: could not turn everything off: ${problem}`); }
  }
  if (failed) throw new Error(`Modes may still be on in ${failed} tab${failed === 1 ? '' : 's'}; modes lists them`);
  if (!any) out.log(mine ? 'None of your modes were on.' : 'No modes were on.');
}

// A tab of the REPL's own: closing it can go back to the tab before. It opens
// in the background, so it does not take the front of the window from the
// person using the browser; Playwright's newPage would bring it to the front.
const OPEN_TIMEOUT = 10000;

// True while tab new opens a tab: watch on --next-tab waits for one someone
// else opens, not one a client of the REPL opens for itself.
let opening = false;

function isOpening() {
  return opening;
}

async function openTab() {
  opening = true;
  try { return await openOwnTab(); } finally { opening = false; }
}

async function openOwnTab() {
  const ctx = state.browser.contexts()[0];
  let opened = null;
  const session = await state.browser.newBrowserCDPSession().catch(() => null);
  if (session) {
    try {
      const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', background: true });
      opened = await pageForTarget(ctx, targetId);
    } catch {} finally {
      await session.detach().catch(() => {});
    }
  }
  // A browser that cannot open one in the background (e.g. some headless ones) opens it as usual.
  if (!opened) opened = await ctx.newPage();
  tabState(opened).opened = true;
  tabState(opened).owner = state.client;
  keepDrawing(opened);
  return opened;
}

// A page's CDP target id, asked for once per page.
async function targetIdOf(ctx, p) {
  if (!('targetId' in tabState(p))) {
    const cdp = await ctx.newCDPSession(p).catch(() => null);
    if (!cdp) return null;
    const info = await cdp.send('Target.getTargetInfo').catch(() => null);
    await cdp.detach().catch(() => {});
    if (!info) return null;
    tabState(p).targetId = info.targetInfo.targetId;
  }
  return tabState(p).targetId;
}

async function pageForTarget(ctx, targetId) {
  const deadline = Date.now() + OPEN_TIMEOUT;
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      if ('opened' in tabState(p)) continue;
      if (await targetIdOf(ctx, p) === targetId) return p;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
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
    const notes = ['start' in tabState(p) && 'the start URL', tabState(p).owner && `opened by ${tabState(p).owner}`].filter(Boolean);
    out.log(`${marker} [${i}] ${p.url()}${notes.length ? `  (${notes.join(', ')})` : ''}`);
    out.log(`        ${JSON.stringify(title)}`);
  }
}

const commands = {
  ...inspectCommands,
  ...captureCommands,
  ...emulationCommands,
  ...networkCommands,
  ...routesCommands,
  ...requestlogCommands,
  ...elementsCommands,
  ...dialogsCommands,
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
      keepDrawing(p);
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
      if (target && all.includes(target)) { select(target); return commands.info(); }
      // Not read as part of a URL instead: that could land in someone else's tab without a word.
      if (target) throw new Error(`Tab [${subcommand}] has closed since the latest listing. Run tab to list them again.`);
      // A number that is not a tab in the listing may be part of a URL (a port).
      const containing = all.filter(p => p.url().includes(subcommand)).length;
      if (!containing) throw new Error(`No tab [${subcommand}] in the latest listing, and no tab URL contains ${subcommand}. Run tab to list them.`);
      if (containing > 1) {
        const listing = state.tabListing.length ? 'the latest listing' : 'a listing yet: each client has its own, from tab';
        throw new Error(`No tab [${subcommand}] in ${listing}. As part of a URL, ${subcommand} is in ${containing} tabs. Run tab, then tab <index>.`);
      }
    }
    if (subcommand === 'new') {
      select(await openTab());
      const url = parts.join(' ');
      if (url) {
        try { await commands.goto(url); }
        catch (error) { throw new Error(`${error.message}\nThe new tab stays open and selected; tab close closes it.`); }
      } else {
        out.log('New tab created and selected');
      }
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
        state.page = back && !back.isClosed() && 'opened' in tabState(back) ? back : null;
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
    // As a browser's address bar does: a local dev server is almost always plain http.
    const local = /^(?:localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)(?:[:/?#]|$)/i.test(url);
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url) && !/^(about|data|file|javascript):/i.test(url)) url = `${local ? 'http' : 'https'}://${url}`;
    await navigating(() => state.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }));
    out.log(`${state.page.url()} — ${await state.page.title()}`);
  },

  async back() {
    await historyStep(() => state.page.goBack({ waitUntil: 'commit', timeout: 10000 }), 'back');
    out.log(`Back to: ${state.page.url()}`);
  },

  async forward() {
    await historyStep(() => state.page.goForward({ waitUntil: 'commit', timeout: 10000 }), 'forward');
    out.log(`Forward to: ${state.page.url()}`);
  },

  async reload() {
    await navigating(() => state.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }));
    out.log(`Reloaded: ${state.page.url()}`);
  },

  async info() {
    out.log(`  URL:   ${state.page.url()}`);
    // Chrome's error page has a URL of its own; the one that failed is in the request log.
    if (state.page.url().startsWith('chrome-error://')) {
      const failed = (tabState(state.page).log || []).filter(e => e.navigation && e.failed && !stayedPut(e)).pop();
      if (failed) out.log(`  Error: Chrome's error page, for #${failed.id} ${failed.url} ${failed.status}`);
    }
    out.log(`  Title: ${await state.page.title()}`);
    out.log(`  Viewport: ${await viewportText()}`);
  },

  async watch(args, all) {
    const arg = (args || '').trim();
    const watch = tabState(state.page).watch;
    const [sub, ...flags] = arg.split(/\s+/);
    const next = flags.indexOf('--next-tab');
    if (sub === 'on' && next !== -1) {
      const part = flags[next + 1] && !flags[next + 1].startsWith('--') ? flags[next + 1] : null;
      const rest = flags.filter((f, i) => i !== next && !(part && i === next + 1));
      if (!rest.every(f => f === '--changes' || f === '--live')) throw new Error('Usage: watch on [--changes] [--live] --next-tab [url-part]');
      nextTab = { part, changes: rest.includes('--changes'), live: rest.includes('--live'), client: state.client };
      out.log(`${waitingText()}: it is watched from its first page, and selected. watch off stops waiting.`);
      return;
    }
    if (sub !== 'on' && arg !== 'off' && waitingForMe() && (!state.page || state.page.isClosed())) {
      out.log(`${waitingText()} (watch on --next-tab); it is selected once it opens, and watch then shows its steps.`);
      return;
    }
    if (sub === 'on' && flags.every(f => f === '--changes' || f === '--live')) {
      if (!state.page || state.page.isClosed()) throw new Error('No tab is selected; select one with tab <index|url-part>, or open one with tab new');
      const changes = flags.includes('--changes');
      const live = flags.includes('--live');
      await startWatching(state.page, changes, live);
      tabState(state.page).watch.owner = state.client;
      out.log(`Watching the selected tab: clicks, typing, form changes, submits and navigations${changes ? ', and what each changed on screen' : ''} (typed values are not recorded)`);
      out.log(live ? 'Each step prints here once it settles; watch shows them again.' : 'watch shows what it has recorded; watch on --live also prints each step here as it happens.');
      return;
    }
    if (arg === 'off') {
      if (nextTab) { nextTab = null; out.log('Stopped waiting to watch a new tab'); }
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

  async modes(args) {
    const arg = (args || '').trim();
    if (!arg) return listModes();
    if (arg !== 'off' && arg !== 'off --mine') throw new Error('Usage: modes [off [--mine]]');
    await allModesOff(arg === 'off --mine');
  },

  async help(args) {
    const topic = (args || '').trim();
    const text = HELP.render(topic);
    if (text === null) throw new Error(HELP.notFound(topic));
    out.log(text);
  },

  async quit() {
    out.log('Disconnecting...');
    await shutdown();
  }
};

// Run for playwright-cli's names (lib/cli-names.js) where no command here does the same.
const cliCommands = {
  // By index only: tab <number> falls back to a tab whose URL contains the number.
  // The index is into the sender's last listing, so a tab someone opened or
  // closed since cannot shift it onto another tab; with none yet, the tabs now.
  async 'tab-select'(args) {
    const all = state.browser.contexts().flatMap(c => c.pages());
    if (!/^\d+$/.test(args)) throw new Error('Usage: tab-select <index>, as tab-list lists the tabs');
    if (!state.tabListing.length) {
      if (!all[Number(args)]) throw new Error(`No tab [${args}]; there ${all.length === 1 ? 'is 1' : `are ${all.length}`}, and tab-list lists them`);
      state.tabListing = all.slice();
    }
    const target = state.tabListing[Number(args)];
    if (!target) throw new Error(`No tab [${args}] in your last listing; tab-list lists them again`);
    if (target.isClosed() || !all.includes(target)) throw new Error(`The tab at [${args}] in your last listing has closed; tab-list lists them again`);
    return commands.tab(args);
  },

  // playwright-cli's close ends its own session. The browser here is shared, so
  // it ends the sender's part in it: its modes are turned off, and every tab,
  // even one it opened, is left open for someone who may be using it.
  async close(args) {
    if (args) throw new Error('Usage: close');
    if (!state.client) {
      throw new Error('close turns off the modes you turned on, which needs a client name: pw-repl send -c <name> close. Without one, they cannot be told from the prompt\'s; modes lists what is on.');
    }
    await allModesOff(true);
    const own = state.browser.contexts().flatMap(c => c.pages()).filter(p => tabState(p).owner === state.client);
    if (own.length) out.log(`Tabs you opened are still open: ${own.map(p => p.url()).join(', ')}; tab close <url-part> closes one, or select it and tab close.`);
  },
};

// Hooks every page needs from the moment the REPL sees it.
function watchPage(p) {
  ensureDialogHandler(p);
  ensureRecentLog(p);
  if (nextTabWanted() && !isOpening()) watchNewTab(p);
}

// watch on --next-tab waits for a tab, and watch off stops waiting, with none selected;
// watch says it is still waiting.
function needsTab(cmd, args) {
  return !(cmd === 'watch' && (/(?:^|\s)--next-tab(?:\s|$)/.test(args) || /^\s*off\s*$/.test(args) || waitingForMe()));
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
    if (command === 'network') return match(['on', 'off', 'slow']);
    if (command === 'emulate') return match([...EMULATE_KINDS, 'off']);
    if (command === 'wait') return match(['text', 'request', 'load']);
    if (command === 'modes') return match(['off']);
    if (command === 'dialog') return match(['accept', 'dismiss']);
    if (command === 'watch') return match(['on', 'off', 'new', '--all']);
    if (command === 'capture') return match(['on', 'off']);
    if (command === 'route') return match(['off']);
  }
  if (words.length >= 3 && command === 'watch' && words[1] === 'on') return match(['--changes', '--live', '--next-tab'].filter(f => !words.slice(2, -1).includes(f)));
  if (words.length === 3 && command === 'capture' && words[1] === 'on') return match(['requests', 'console']);
  if (words.length === 3 && command === 'emulate' && EMULATE_KINDS.includes(words[1])) return match(['off']);
  if (words.length === 3 && command === 'route' && words[1] === 'off') return match(['--all', ...(state.page ? routesFor(state.page).keys() : [])]);
  return [[], current];
}

module.exports = { commands, cliCommands, needsTab, dialogCommand, listTabs, openTab, markStartTab, activeModes, watchPage, complete, compactSnapshot, grepSnapshot, summarizeChanges, scrubEditable, clock };
