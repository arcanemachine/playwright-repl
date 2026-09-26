const path = require('path');
const fs = require('fs');
const { state, withTimeout, onShutdown, shutdown } = require('./state');
const out = require('./output');
const HELP = require('./help');
const { devices } = require('playwright-core');
const { toSelector, unquote, splitSelector } = require('./syntax');

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
  if (!state.page || state.page.isClosed()) throw new Error('No tab is selected; select one with tab <index|url-part>, or open one with tab new');
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
  const page = state.page;
  const listen = (event, handler) => { page.on(event, handler); handlers.push([event, handler]); };
  if (label !== 'console') listen('request', req => record({ t: Date.now(), tag: 'request', req, text: `${req.method()} ${req.url()}` }));
  if (label !== 'requests') {
    listen('console', msg => record({ t: Date.now(), tag: msg.type(), text: consoleText(msg) }));
    listen('pageerror', error => record({ t: Date.now(), tag: 'pageerror', text: error.stack || error.message }));
  }
  // A capture must not outlive its tab: nothing could see or stop it.
  listen('close', () => {
    if (cap?.page !== page) return;
    endCapture();
    out.notice('The captured tab closed, which ended the capture; capture shows what it recorded.');
  });
  const capture = {
    page, label, startedAt, events, handlers, wake: null,
    get dropped() { return dropped; },
    get shortened() { return shortened; },
  };
  cap = capture;
  if (seconds) {
    out.log(`Capturing ${label} for ${seconds}s...`);
    // Also ends early if the capture does, e.g. because its tab closed.
    await new Promise(resolve => {
      const timer = setTimeout(resolve, seconds * 1000);
      capture.wake = () => { clearTimeout(timer); resolve(); };
    });
    if (cap === capture) stopCapture();
    else printCapture(lastCapture);
  } else {
    out.log(`Capturing ${label}; capture off stops it and prints what it recorded.`);
  }
}

function endCapture() {
  cap.handlers.forEach(([event, h]) => cap.page.off(event, h));
  const { label, startedAt, events, dropped, shortened, wake } = cap;
  cap = null;
  lastCapture = { label, startedAt, events, dropped, shortened };
  if (wake) wake();
}

function stopCapture(all = false) {
  if (!cap) { out.log('Not capturing.'); return; }
  endCapture();
  printCapture(lastCapture, all);
}

// What a command run on its own prints after its state: the commands that
// come next, set apart from the state by a blank line.
function hints(pairs) {
  const width = Math.max(...pairs.map(([command]) => command.length));
  return `\n${pairs.map(([command, what]) => `  ${command.padEnd(width)}  ${what}`).join('\n')}`;
}

const dialogPages = new WeakSet();

// page -> its open dialog. The page, and every command that reads it, waits
// until the dialog is answered, in the browser or with the dialog command.
const openDialogs = new Map();

function ensureDialogHandler(p) {
  if (dialogPages.has(p)) return;
  dialogPages.add(p);
  p.on('dialog', dialog => {
    openDialogs.set(p, dialog);
    out.notice(`Dialog [${dialog.type()}]: ${String(dialog.message()).slice(0, OUTPUT_LIMIT)}`);
    out.notice('It waits to be answered in the browser, or with dialog accept [text] | dialog dismiss; until then the page, and commands that read it, wait too.');
  });
  p.on('close', () => openDialogs.delete(p));
}

// Runs ahead of the command queue (see runner.js), so it still works while
// commands wait on the dialog; it returns its output rather than printing it.
async function dialogCommand(args) {
  const [action, ...rest] = (args || '').trim().split(/\s+/).filter(Boolean);
  const pages = state.browser.contexts().flatMap(c => c.pages());
  for (const p of openDialogs.keys()) if (p.isClosed() || !pages.includes(p)) openDialogs.delete(p);
  const describe = (p, d) => `[${pages.indexOf(p)}] ${p.url()}: ${d.type()} ${JSON.stringify(String(d.message()).slice(0, 200))}`;
  if (!action) {
    if (!openDialogs.size) return 'No dialog is open.';
    return [...[...openDialogs].map(([p, d]) => describe(p, d)), hints([['dialog accept [text]', 'accept it (text answers a prompt)'], ['dialog dismiss', 'dismiss it']])].join('\n');
  }
  if (action !== 'accept' && action !== 'dismiss') throw new Error('Usage: dialog [accept [text] | dismiss]');
  // The selected tab's dialog, or the only one open.
  const page = openDialogs.has(state.page) ? state.page : openDialogs.size === 1 ? [...openDialogs.keys()][0] : null;
  if (!page) throw new Error(openDialogs.size ? 'Several tabs have a dialog open; select one with tab <index|url-part> first' : 'No dialog is open.');
  const dialog = openDialogs.get(page);
  openDialogs.delete(page);
  const line = describe(page, dialog);
  try {
    if (action === 'accept') await dialog.accept(rest.length ? unquote(rest.join(' ')) : undefined);
    else await dialog.dismiss();
  } catch (error) {
    // Answered in the browser meanwhile.
    return `No dialog is open (${error.message.split('\n')[0]})`;
  }
  return `${action === 'accept' ? 'Accepted' : 'Dismissed'}: ${line}`;
}

// A tab in a browser the REPL connected to has no viewport set, so its size is
// the window's; it is read from the page.
async function viewportText() {
  const device = emulations.get(state.page)?.device;
  if (device) return `${devices[device].viewport.width}x${devices[device].viewport.height} (emulate mobile: ${device})`;
  const set = state.page.viewportSize();
  if (set) return `${set.width}x${set.height} (set with viewport)`;
  const size = await state.page.evaluate(() => `${innerWidth}x${innerHeight}`).catch(() => null);
  return size ? `${size} (the window's size)` : 'unknown';
}

// A page restored from the back/forward cache never fires its load events
// again, so back and forward wait only for the navigation, then briefly for
// the page, rather than time out on a page that is already there.
async function historyStep(go, direction) {
  const before = state.page.url();
  const response = await go();
  if (response === null && state.page.url() === before) throw new Error(`No page to go ${direction} to`);
  await state.page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
}

const SCREENSHOT_DELAY_MAX = 60;

function nextScreenshotPath(name) {
  const filename = name ? `screenshot-${name}` : `screenshot-${Date.now()}`;
  return path.join(SCREENSHOT_DIR, `${filename}.png`);
}

// Per page: a CDP session's emulation applies to the page it is attached to
// and resets, in part, when it detaches, so one is kept for each tab.
const keptSessions = new WeakMap();

function keptSession(p) {
  if (!keptSessions.has(p)) keptSessions.set(p, p.context().newCDPSession(p).catch(error => { keptSessions.delete(p); throw error; }));
  return keptSessions.get(p);
}

const networkEnabled = new WeakSet();
// page -> how its network is changed: { offline: true }, or slowed { latency, down, up } (ms, kbps).
const networkChanged = new WeakMap();
// DevTools' "Slow 4G".
const SLOW_DEFAULT = { latency: 563, down: 1440, up: 675 };
const SLOW_LATENCY_MAX = 10000;

// setting null restores the network.
async function setNetwork(p, setting) {
  const session = await keptSession(p);
  if (!networkEnabled.has(p)) { await session.send('Network.enable'); networkEnabled.add(p); }
  await session.send('Network.emulateNetworkConditions', {
    offline: !!setting?.offline,
    latency: setting?.latency || 0,
    // kbps to bytes per second; -1 is no limit.
    downloadThroughput: setting?.down ? setting.down * 125 : -1,
    uploadThroughput: setting?.up ? setting.up * 125 : -1,
  });
  if (setting) networkChanged.set(p, setting); else networkChanged.delete(p);
}

function networkText(setting) {
  return setting.offline ? 'off (offline)' : `slow (${setting.latency}ms latency, ${setting.down} kbps down, ${setting.up} kbps up)`;
}

// page -> what emulate changed: { device, scheme, locale, timezone }, each unset when off.
const emulations = new WeakMap();
const DEFAULT_DEVICE = 'Pixel 7';
const EMULATE_KINDS = ['mobile', 'dark', 'light', 'locale', 'timezone'];

function emulatedKinds(e) {
  return [e?.device && 'mobile', e?.scheme, e?.locale && 'locale', e?.timezone && 'timezone'].filter(Boolean);
}

const DEVICES_SHOWN = 20;

function deviceNamed(name) {
  const names = Object.keys(devices);
  const found = names.find(d => d.toLowerCase() === name.toLowerCase());
  if (found) return found;
  // The names that have every word typed, so a near miss finds the exact name.
  const words = name.toLowerCase().split(/\s+/);
  const close = names.filter(d => !/ landscape$/.test(d) && words.every(w => d.toLowerCase().includes(w)));
  if (!close.length) throw new Error(`No device ${JSON.stringify(name)}; names are Playwright's, e.g. Pixel 7, iPhone 13, iPad Mini, Galaxy S9+`);
  const more = close.length > DEVICES_SHOWN ? `, and ${close.length - DEVICES_SHOWN} more` : '';
  throw new Error(`No device ${JSON.stringify(name)}; matching: ${close.slice(0, DEVICES_SHOWN).join(', ')}${more} (each also as "<name> landscape")`);
}

function deviceText(name) {
  const d = devices[name];
  return `${name}, ${d.viewport.width}x${d.viewport.height} at ${d.deviceScaleFactor}x${d.hasTouch ? ', touch' : ''}`;
}

// Sends only what changed. Chrome takes the user agent and the languages
// together, so a change to either sends both.
async function setEmulation(p, next) {
  const session = await keptSession(p);
  const previous = emulations.get(p) || {};
  const send = (method, params) => session.send(method, params);
  if (next.device !== previous.device) {
    const d = devices[next.device];
    if (d) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: d.viewport.width, height: d.viewport.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.isMobile,
        screenWidth: d.screen?.width || d.viewport.width, screenHeight: d.screen?.height || d.viewport.height,
      });
    } else {
      await send('Emulation.clearDeviceMetricsOverride');
    }
    await send('Emulation.setTouchEmulationEnabled', d?.hasTouch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  }
  if (next.device !== previous.device || next.locale !== previous.locale) {
    if (next.device || next.locale) {
      const userAgent = next.device ? devices[next.device].userAgent : (await send('Browser.getVersion')).userAgent;
      await send('Emulation.setUserAgentOverride', { userAgent, ...(next.locale ? { acceptLanguage: next.locale } : {}) });
    } else {
      // An empty user agent ends the override.
      await send('Emulation.setUserAgentOverride', { userAgent: '' });
    }
  }
  if (next.locale !== previous.locale) await send('Emulation.setLocaleOverride', next.locale ? { locale: next.locale } : {});
  if (next.timezone !== previous.timezone) await send('Emulation.setTimezoneOverride', { timezoneId: next.timezone || '' });
  if (next.scheme !== previous.scheme) await send('Emulation.setEmulatedMedia', { features: next.scheme ? [{ name: 'prefers-color-scheme', value: next.scheme }] : [] });
  if (emulatedKinds(next).length) emulations.set(p, next); else emulations.delete(p);
}

function showEmulation() {
  const e = emulations.get(state.page);
  const forms = [
    ['emulate mobile [device]', `a phone's screen, touch and user agent (default ${DEFAULT_DEVICE})`],
    ['emulate dark | light', 'the color scheme the page sees'],
    ['emulate locale <tag>', 'its language and formats, e.g. fr-FR'],
    ['emulate timezone <zone>', 'e.g. Asia/Tokyo'],
  ];
  if (!e) {
    out.log('Nothing is emulated in the selected tab.');
    out.log(hints(forms));
    return;
  }
  out.log('Emulated in the selected tab:');
  const rows = [
    e.device && ['mobile', deviceText(e.device)],
    e.scheme && ['color scheme', e.scheme],
    e.locale && ['locale', e.locale],
    e.timezone && ['timezone', e.timezone],
  ].filter(Boolean);
  for (const [what, value] of rows) out.log(`  ${what.padEnd(12)}  ${value}`);
  out.log(hints([...forms, ['emulate <what> off | emulate off', 'stop one, or all']]));
}

// Resets every tab's emulation, which detaching would only partly undo.
async function resetEmulations() {
  if (!state.browser || state.connectionLost) return;
  const pages = state.browser.contexts().flatMap(c => c.pages()).filter(p => emulations.has(p) && !p.isClosed());
  await Promise.all(pages.map(p => setEmulation(p, {}).catch(() => {})));
}

// page -> Map(glob -> { status, body, handler }). Playwright routes are
// registered per page, so the listing is too.
const pageRoutes = new WeakMap();
const ROUTE_PREVIEW = 80;

function routesFor(p) {
  if (!pageRoutes.has(p)) pageRoutes.set(p, new Map());
  return pageRoutes.get(p);
}

const ROUTE_DELAY_MAX = 120;

// Marks a request a route answered, now: the browser reports it finished only later.
function markChanged(req, status, how) {
  changedRequests.set(req, how);
  const entry = requestEntries.get(req);
  if (entry) { entry.status = `${status} ${how}`; entry.ms = Date.now() - entry.t; }
}

// A JSON Merge Patch (RFC 7386): objects merge, null removes a key, anything else replaces.
function mergePatch(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

function parseJson(text, what) {
  try { return JSON.parse(text); } catch (error) { throw new Error(`${what} is not valid JSON: ${error.message}`); }
}

// How a route treats the requests it matches: its text for listing, and what it does to each one.
function routeKind(how, rest, usage) {
  if (/^\d{3}$/.test(how)) {
    const status = Number(how);
    if (status < 200 || status > 599) throw new Error('Status must be from 200 to 599');
    if (!rest) throw new Error(usage);
    parseJson(rest, 'Body');
    const preview = rest.length > ROUTE_PREVIEW ? `${rest.slice(0, ROUTE_PREVIEW)}…` : rest;
    return {
      text: `${status} ${preview}`,
      async handle(r, req, tag) {
        markChanged(req, status, 'faked');
        await r.fulfill({ status, contentType: 'application/json', body: rest });
        out.notice(`Faked: ${tag()} -> ${status}`);
      },
    };
  }
  if (how === 'patch') {
    if (!rest) throw new Error(usage);
    const patch = parseJson(rest, 'Patch');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Patch must be a JSON object, e.g. {"total": 0}');
    return {
      text: `patch ${rest.length > ROUTE_PREVIEW ? `${rest.slice(0, ROUTE_PREVIEW)}…` : rest}`,
      async handle(r, req, tag) {
        const response = await r.fetch();
        let body;
        try { body = await response.json(); } catch {
          await r.fulfill({ response });
          out.notice(`Not patched: ${tag()} — its response is not JSON, so it went through unchanged`);
          return;
        }
        markChanged(req, response.status(), 'patched');
        await r.fulfill({ response, json: mergePatch(body, patch) });
        out.notice(`Patched: ${tag()} -> ${response.status()}`);
      },
    };
  }
  if (how === 'delay') {
    const seconds = Number(rest);
    if (!/^\d+(?:\.\d+)?$/.test(rest || '') || seconds <= 0 || seconds > ROUTE_DELAY_MAX) throw new Error(`Usage: route <url-glob> delay <seconds> (up to ${ROUTE_DELAY_MAX})`);
    return {
      text: `delay ${seconds}s`,
      async handle(r, req, tag) {
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        await r.continue();
        out.notice(`Delayed ${seconds}s: ${tag()}`);
      },
    };
  }
  if (how === 'abort' && !rest) {
    return {
      text: 'abort',
      async handle(r, req, tag) {
        await r.abort('failed');
        out.notice(`Aborted: ${tag()}`);
      },
    };
  }
  throw new Error(usage);
}

function listRoutes() {
  const routes = routesFor(state.page);
  const forms = [
    ['route <url-glob> <status> <json-body>', 'answer it with this status and JSON'],
    ['route <url-glob> patch <json>', 'let it through, then change its JSON'],
    ['route <url-glob> delay <seconds>', 'hold it, then let it through'],
    ['route <url-glob> abort', 'fail it as if the connection broke'],
  ];
  if (!routes.size) {
    out.log('No routes on the selected tab.');
    out.log(hints(forms));
    return;
  }
  out.log(`Routes on the selected tab (${routes.size}):`);
  const width = Math.max(...[...routes.keys()].map(glob => glob.length));
  for (const [glob, { text }] of routes) out.log(`  ${glob.padEnd(width)}  ${text}`);
  out.log(hints([...forms, ['route off <url-glob> | route off --all', 'remove']]));
}

async function removeRoutes(glob) {
  if (!glob) throw new Error('Usage: route off <url-glob> | route off --all');
  const routes = routesFor(state.page);
  if (glob !== '--all' && !routes.has(glob)) throw new Error(`No route for ${glob} on the selected tab`);
  const removed = await unroute(state.page, glob === '--all' ? [...routes.keys()] : [glob]);
  for (const g of removed) out.log(`Removed: ${g}`);
  if (!removed.length) out.log('No routes on the selected tab');
}

async function unroute(p, globs) {
  const routes = routesFor(p);
  for (const g of globs) {
    await p.unroute(g, routes.get(g).handler);
    routes.delete(g);
  }
  return globs;
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
// request -> how a route changed it (faked or patched), shown after its status.
const changedRequests = new WeakMap();
const requestEntries = new WeakMap();
// page -> when its page last fired its load event.
const loadedAt = new WeakMap();
// Tabs this REPL opened with tab new.
const openedTabs = new WeakSet();

function clipText(text) {
  return text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT)}…` : text;
}

// The browser's own "Failed to load resource" message does not say which one.
function consoleText(msg) {
  const text = msg.text();
  const url = msg.location()?.url;
  return /^Failed to load resource/.test(text) && url ? `${text}: ${url}` : text;
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
    let navigation = false;
    try { navigation = req.isNavigationRequest() && req.frame() === p.mainFrame(); } catch {}
    const entry = { id: nextId++, t: Date.now(), method: req.method(), url: req.url(), type: req.resourceType(), status: 'pending', ms: null, response: null, navigation };
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
    finish(req, changedRequests.has(req) ? `${status} ${changedRequests.get(req)}` : status, res);
  });
  p.on('requestfailed', req => finish(req, `failed: ${req.failure()?.errorText || 'unknown'}`));
  p.on('load', () => loadedAt.set(p, Date.now()));
  p.on('console', msg => keep(logs, { t: Date.now(), type: msg.type(), text: clipText(consoleText(msg)) }));
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
    const busy = () => (recentLogs.get(p) || []).some(r => r.t >= step.t && r.status === 'pending' && !RECENT_HIDDEN_TYPES.has(r.type));
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
  let watch = watches.get(p);
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
  } else if (!watch.on) {
    // A watch on after watch off is a new recording: the old steps would read as part of it.
    watch.events.length = 0;
    watch.shownSeq = watch.nextSeq - 1;
    watch.shownRequestId = Math.max(0, ...(recentLogs.get(p) || []).map(r => r.id));
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

// For each step of a watch, the requests made between it and the next step.
function requestsByStep(watch, p = state.page) {
  const requests = (recentLogs.get(p) || []).filter(r => !WATCH_HIDDEN_TYPES.has(r.type) && !r.url.startsWith('chrome-extension://'));
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
  if (watches.get(p)?.on) modes.push('watch');
  const network = networkChanged.get(p);
  if (network) modes.push(network.offline ? 'network:off' : 'network:slow');
  const emulated = emulatedKinds(emulations.get(p));
  if (emulated.length) modes.push(`emulate:${emulated.join(',')}`);
  const routes = pageRoutes.get(p)?.size;
  if (routes) modes.push(`routes:${routes}`);
  if (cap && cap.page === p) modes.push('capture');
  return modes;
}

function listModes() {
  const all = state.browser.contexts().flatMap(c => c.pages());
  state.tabListing = all.slice();
  const on = all.map((p, i) => [p, i, activeModes(p)]).filter(([, , modes]) => modes.length);
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
  for (const [p, i, modes] of on) out.log(`${p === state.page ? '*' : ' '} ${`[${i}] ${p.url()}`.padEnd(width)}  (${modes.join(' ')})`);
  out.log(hints([['modes off', 'turn them all off']]));
}

// Turns off everything the REPL turned on, in every tab: nothing it leaves
// behind keeps acting on someone's browser.
async function allModesOff() {
  const all = state.browser.contexts().flatMap(c => c.pages());
  let any = false;
  let failed = 0;
  // A tab that fails (e.g. it crashed) must not keep the others' modes on.
  for (const p of all) {
    const done = [];
    let problem = null;
    try {
      const watch = watches.get(p);
      if (watch?.on) { stopWatching(p, watch); done.push('watch off'); }
      if (cap && cap.page === p) { endCapture(); done.push('capture off (capture shows it)'); }
      const globs = [...(pageRoutes.get(p)?.keys() || [])];
      if (globs.length) { await unroute(p, globs); done.push(`${globs.length} route${globs.length === 1 ? '' : 's'} removed`); }
      if (networkChanged.has(p)) { await setNetwork(p, null); done.push('network on'); }
      if (emulations.has(p)) { await setEmulation(p, {}); done.push('emulate off'); }
    } catch (error) {
      problem = error.message;
    }
    if (done.length) { any = true; out.log(`${p.url()}: ${done.join(', ')}`); }
    if (problem) { failed += 1; out.error(`${p.url()}: could not turn everything off: ${problem}`); }
  }
  if (failed) throw new Error(`Modes may still be on in ${failed} tab${failed === 1 ? '' : 's'}; modes lists them`);
  if (!any) out.log('No modes were on.');
}

// The type a page sees for a file it is given, from its extension.
const MIME_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html',
  xml: 'application/xml', zip: 'application/zip', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  wav: 'audio/wav', doc: 'application/msword', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function mimeType(file) {
  return MIME_TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
}

// Commands that take only a selector take the whole line, spaces and all.
function soleSelector(args, usage) {
  const text = unquote((args || '').trim());
  if (!text) throw new Error(`Usage: ${usage}`);
  return toSelector(text);
}

function selectorAndValue(args, usage, example) {
  const parsed = splitSelector(args);
  if (!parsed || parsed.rest === undefined) {
    throw new Error(`Usage: ${usage}, e.g. ${example}; quote a selector with spaces: "text=Your name"`);
  }
  return { selector: parsed.selector, value: unquote(parsed.rest), shown: parsed.word };
}

// An element that never appeared is said plainly, not as Playwright's call
// log. A ref that no longer matches usually means the page changed since the
// snapshot it came from.
async function onElement(selector, action) {
  try {
    return await action();
  } catch (error) {
    if (/resolved to/.test(error.message)) throw error;
    const ref = selector.startsWith('aria-ref=') ? selector.slice(9) : null;
    const staleRef = ref ? `\n${ref} is a snapshot ref; if the page changed since that snapshot, take a new one.` : '';
    const waited = /Timeout (\d+)ms exceeded[\s\S]*waiting for locator/.exec(error.message);
    if (waited) throw new Error(`No element matches ${ref || selector} (waited ${waited[1] / 1000}s)${staleRef}`);
    error.message += staleRef;
    throw error;
  }
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

// Done once the page has loaded: after the latest navigation of the tab that
// began since the previous command did (the click on a link, say), or, with
// none, the document there now. Waiting on Playwright's load state alone would
// see the page being left, which has already loaded.
async function waitForLoad(timeout) {
  const p = state.page;
  const since = state.previousCommandAt || 0;
  const deadline = Date.now() + timeout;
  for (;;) {
    const navigation = (recentLogs.get(p) || []).filter(e => e.navigation && e.t >= since).pop();
    if (navigation && navigation.status.startsWith('failed')) throw new Error(`The page did not load: #${navigation.id} ${navigation.url} ${navigation.status}`);
    const loaded = navigation ? (loadedAt.get(p) || 0) >= navigation.t : await p.evaluate(() => document.readyState === 'complete').catch(() => false);
    if (loaded) { out.log(`Loaded: ${p.url()} — ${await p.title().catch(() => '')}`); return; }
    if (Date.now() >= deadline) throw new Error(`${p.url()} did not finish loading within ${timeout / 1000}s`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// Gone once no match is visible, whether it was removed or hidden.
async function waitGone(locator, what, timeout) {
  try {
    await locator.filter({ visible: true }).first().waitFor({ state: 'detached', timeout });
  } catch (error) {
    if (/Timeout \d+ms exceeded/.test(error.message)) throw new Error(`Still visible after ${timeout / 1000}s: ${what}`);
    throw error;
  }
  out.log(`Gone: ${what}`);
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
      const around = stack.filter(a => !/^generic(?: \[|$)/.test(a.label));
      // A hit with no ref of its own (text) keeps the ref of what holds it, so
      // snapshot <ref> can show what sits beside it: the value next to a label.
      const own = /\[ref=/.test(line);
      const path = around.map((a, i) => (!own && i === around.length - 1 ? a.label : a.label.replace(/ \[ref=[^\]]+\]/g, '')));
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

// One line per event, from the start of the capture: a request as requests
// shows it (its status is looked up now, so it is known if it has finished),
// a console message or page error as console shows it.
function printCapture(capture, all = false) {
  const lines = capture.events.map(event => {
    const at = `+${((event.t - capture.startedAt) / 1000).toFixed(3)}s`;
    if (event.tag !== 'request') return `${at} [${event.tag}] ${event.text}`;
    const entry = requestEntries.get(event.req);
    return entry ? `${at} #${entry.id} ${entry.method} ${entry.status} ${entry.url}` : `${at} ${event.text}`;
  });
  if (lines.length) printOutput(lines.join('\n'), all);
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

// A tab of the REPL's own: closing it can go back to the tab before. It opens
// in the background, so it does not take the front of the window from the
// person using the browser; Playwright's newPage would bring it to the front.
const OPEN_TIMEOUT = 10000;

async function openTab() {
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
  openedTabs.add(opened);
  return opened;
}

// page -> its CDP target id, asked for once per page.
const targetIds = new WeakMap();

async function targetIdOf(ctx, p) {
  if (!targetIds.has(p)) {
    const cdp = await ctx.newCDPSession(p).catch(() => null);
    if (!cdp) return null;
    const info = await cdp.send('Target.getTargetInfo').catch(() => null);
    await cdp.detach().catch(() => {});
    if (!info) return null;
    targetIds.set(p, info.targetInfo.targetId);
  }
  return targetIds.get(p);
}

async function pageForTarget(ctx, targetId) {
  const deadline = Date.now() + OPEN_TIMEOUT;
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      if (openedTabs.has(p)) continue;
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
      if (target && all.includes(target)) { select(target); return commands.info(); }
      // A number that is not a tab in the listing may be part of a URL (a port).
      if (!all.some(p => p.url().includes(subcommand))) throw new Error(`No tab [${subcommand}] in the latest listing, and no tab URL contains ${subcommand}. Run tab to list them.`);
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
    // As a browser's address bar does: a local dev server is almost always plain http.
    const local = /^(?:localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)(?:[:/?#]|$)/i.test(url);
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url) && !/^(about|data|file|javascript):/i.test(url)) url = `${local ? 'http' : 'https'}://${url}`;
    await state.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
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
    await state.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    out.log(`Reloaded: ${state.page.url()}`);
  },

  async info() {
    out.log(`  URL:   ${state.page.url()}`);
    out.log(`  Title: ${await state.page.title()}`);
    out.log(`  Viewport: ${await viewportText()}`);
  },

  async click(args) {
    const selector = soleSelector(args, 'click <selector>');
    await onElement(selector, () => state.page.click(selector, { timeout: 5000 }));
    out.log(`Clicked: ${args.trim()}`);
  },

  async dblclick(args) {
    const selector = soleSelector(args, 'dblclick <selector>');
    await onElement(selector, () => state.page.dblclick(selector, { timeout: 5000 }));
    out.log(`Double-clicked: ${args.trim()}`);
  },

  async hover(args) {
    const selector = soleSelector(args, 'hover <selector>');
    await onElement(selector, () => state.page.hover(selector, { timeout: 5000 }));
    out.log(`Hovered: ${args.trim()}`);
  },

  async fill(args) {
    const { selector, value, shown } = selectorAndValue(args, 'fill <selector> <value>', 'fill #name Ada Lovelace');
    await onElement(selector, () => state.page.fill(selector, value, { timeout: 5000 }));
    out.log(`Filled: ${shown}`);
  },

  async type(args) {
    const { selector, value, shown } = selectorAndValue(args, 'type <selector> <text>', 'type #search garden hose');
    // Typed after what the field already holds, as someone clicking into it
    // at the end would; focusing it alone leaves the caret at the start.
    await onElement(selector, () => state.page.locator(selector).first().evaluate(el => {
      el.focus();
      if (typeof el.value === 'string' && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
      } else if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
    }, null, { timeout: 5000 }));
    await state.page.keyboard.type(value);
    out.log(`Typed into: ${shown}`);
  },

  async press(args) {
    const parsed = splitSelector(args);
    if (!parsed) throw new Error('Usage: press <key> | press <selector> <key>, e.g. press Enter or press #name Enter');
    if (parsed.rest === undefined) {
      await state.page.keyboard.press(parsed.word);
      out.log(`Pressed: ${parsed.word}`);
      return;
    }
    const key = unquote(parsed.rest);
    await onElement(parsed.selector, () => state.page.press(parsed.selector, key, { timeout: 5000 }));
    out.log(`Pressed ${key} on ${parsed.word}`);
  },

  async select(args) {
    const { selector, value, shown } = selectorAndValue(args, 'select <selector> <value>', 'select #country Canada');
    await onElement(selector, () => state.page.selectOption(selector, value, { timeout: 5000 }));
    out.log(`Selected "${value}" in ${shown}`);
  },

  async check(args) {
    const selector = soleSelector(args, 'check <selector>');
    await onElement(selector, () => state.page.check(selector, { timeout: 5000 }));
    out.log(`Checked: ${args.trim()}`);
  },

  async uncheck(args) {
    const selector = soleSelector(args, 'uncheck <selector>');
    await onElement(selector, () => state.page.uncheck(selector, { timeout: 5000 }));
    out.log(`Unchecked: ${args.trim()}`);
  },

  // The files are read here and handed to the page as their contents, not
  // their paths: the browser may run on another machine, or in another
  // container, where the paths mean nothing.
  async upload(args) {
    const parsed = splitSelector(args);
    if (!parsed || parsed.rest === undefined) throw new Error('Usage: upload <selector> <file>..., e.g. upload "input[type=file]" photo.png; quote a path with spaces');
    const files = [...parsed.rest.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(m => path.resolve(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]));
    const payloads = files.map(file => {
      let buffer;
      try { buffer = fs.readFileSync(file); } catch (error) { throw new Error(`Cannot read ${file}: ${error.code === 'ENOENT' ? 'no such file' : error.code === 'EISDIR' ? 'it is a folder' : error.message}`); }
      return { name: path.basename(file), mimeType: mimeType(file), buffer };
    });
    const { selector } = parsed;
    await onElement(selector, async () => {
      try {
        await state.page.setInputFiles(selector, payloads, { timeout: 5000 });
      } catch (error) {
        if (!/not an HTMLInputElement/.test(error.message)) throw error;
        // A button that opens the file picker itself: click it, and answer the picker.
        const [chooser] = await Promise.all([state.page.waitForEvent('filechooser', { timeout: 5000 }), state.page.click(selector, { timeout: 5000 })]);
        await chooser.setFiles(payloads);
      }
    });
    out.log(`Chose ${files.length === 1 ? 'a file' : `${files.length} files`} in ${parsed.word}: ${files.join(', ')}`);
  },

  async text(args, all) {
    const selector = soleSelector(args, 'text <selector>');
    printOutput(await onElement(selector, () => state.page.innerText(selector, { timeout: 5000 })), all);
  },

  async html(args, all) {
    const selector = soleSelector(args, 'html <selector>');
    printOutput(await onElement(selector, () => state.page.$eval(selector, el => el.outerHTML)), all);
  },

  async attrs(args, all) {
    const selector = soleSelector(args, 'attrs <selector>');
    const result = await onElement(selector, () => state.page.$eval(selector, el => {
      const out = {};
      for (const attr of el.attributes) out[attr.name] = attr.value;
      return out;
    }));
    printOutput(result, all);
  },

  // The page's own event listeners on an element, which only DevTools can
  // list: the element is handed to a CDP session through the page, so any
  // Playwright selector works, and the session asks for its listeners.
  async listeners(args, all) {
    const text = (args || '').trim();
    const usage = 'listeners <selector> | listeners document | listeners window';
    if (!text) throw new Error(`Usage: ${usage}`);
    const which = text === 'document' || text === 'window' ? text : null;
    const selector = which ? null : soleSelector(args, usage);
    if (selector) await onElement(selector, () => state.page.locator(selector).first().evaluate(el => { window.__pwReplListenersOf = el; }, null, { timeout: 5000 }));
    const cdp = await state.page.context().newCDPSession(state.page);
    try {
      // Chrome includes each handler's source only for an object in a named group.
      const { result } = await cdp.send('Runtime.evaluate', { expression: which || 'window.__pwReplListenersOf', objectGroup: 'pw-repl-listeners' });
      if (!result.objectId) throw new Error(`No element matches ${text}`);
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      if (!listeners.length) { out.log(`No event listeners on ${text}`); return; }
      const lines = listeners.map(l => {
        const how = [l.useCapture && 'capture', l.once && 'once', l.passive && 'passive'].filter(Boolean).join(', ');
        const handler = (l.handler?.description || '').replace(/\s+/g, ' ').slice(0, 100);
        return `${l.type}${how ? ` (${how})` : ''}: ${handler} (line ${l.lineNumber + 1})`;
      });
      printOutput(lines.join('\n'), all);
    } finally {
      await cdp.send('Runtime.evaluate', { expression: 'delete window.__pwReplListenersOf' }).catch(() => {});
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'pw-repl-listeners' }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
  },

  async count(args) {
    const selector = soleSelector(args, 'count <selector>');
    const els = await state.page.$$(selector);
    out.log(`${els.length} element(s)`);
  },

  async visible(args) {
    const selector = soleSelector(args, 'visible <selector>');
    const el = await state.page.$(selector);
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
    // Chrome does not draw a tab that is not in front, and tabs open in the
    // background, so the tab is brought to the front for the shot.
    await state.page.bringToFront();
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
    const selector = toSelector(rest);
    const target = selector ? state.page.locator(selector).first() : state.page;
    const raw = selector ? await onElement(selector, () => target.ariaSnapshot({ mode: 'ai', timeout: 5000 })) : await target.ariaSnapshot({ mode: 'ai', timeout: 5000 });
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
    if (!args) { out.log(await viewportText()); return; }
    const [w, h] = args.split('x').map(Number);
    if (!w || !h) throw new Error('Usage: viewport <width>x<height>');
    // Both set the screen size; whichever came last would win without saying so.
    if (emulations.get(state.page)?.device) throw new Error('emulate mobile sets the size of the selected tab; emulate mobile off first');
    await state.page.setViewportSize({ width: w, height: h });
    out.log(`Viewport set to ${w}x${h}`);
  },

  // Per tab, like network: the settings live in the tab's kept CDP session.
  async emulate(args) {
    const words = (args || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return showEmulation();
    const usage = 'Usage: emulate [mobile [device] | dark | light | locale <tag> | timezone <zone>], emulate <what> off, emulate off';
    const [what, ...rest] = words;
    const value = rest.join(' ');
    const current = emulations.get(state.page) || {};
    if (what === 'off' && !rest.length) {
      const was = emulatedKinds(current);
      await setEmulation(state.page, {});
      out.log(was.length ? `Stopped emulating in the selected tab: ${was.join(', ')}` : 'Nothing was emulated in the selected tab.');
      return;
    }
    if (!EMULATE_KINDS.includes(what)) throw new Error(usage);
    const key = { mobile: 'device', dark: 'scheme', light: 'scheme', locale: 'locale', timezone: 'timezone' }[what];
    if (value === 'off') {
      await setEmulation(state.page, { ...current, [key]: undefined });
      out.log(`Stopped emulating ${key === 'scheme' ? 'the color scheme' : what} in the selected tab`);
      return;
    }
    let next;
    if (what === 'mobile') {
      next = deviceNamed(value || DEFAULT_DEVICE);
    } else if (what === 'dark' || what === 'light') {
      if (value) throw new Error(usage);
      next = what;
    } else if (!value || rest.length > 1) {
      throw new Error(`Usage: emulate ${what} ${what === 'locale' ? '<tag>, e.g. fr-FR' : '<zone>, e.g. Asia/Tokyo'}`);
    } else if (what === 'locale') {
      try { next = Intl.getCanonicalLocales(value)[0]; } catch { throw new Error(`Not a locale: ${value}; e.g. fr-FR, de, pt-BR`); }
    } else {
      // Checked, but kept as given: Node's names can be older ones (Asia/Calcutta for Asia/Kolkata).
      try { new Intl.DateTimeFormat('en-US', { timeZone: value }); } catch { throw new Error(`Not a timezone: ${value}; e.g. Asia/Tokyo, America/New_York, UTC`); }
      next = value;
    }
    await setEmulation(state.page, { ...current, [key]: next });
    const shown = what === 'mobile' ? `mobile (${deviceText(next)})` : what === 'dark' || what === 'light' ? `${what} mode` : `${what} ${next}`;
    out.log(`Emulating ${shown} in the selected tab`);
    // The page reads these when it loads; the rest applies at once.
    if (what === 'mobile' || what === 'locale') out.log('The page sees its user agent, touch and languages from its next load: reload to see all of it.');
  },

  async wait(args) {
    const usage = 'Usage: wait <selector> | wait text <text> | wait request <url-part|glob> | wait load, with optional [seconds]; --gone for a selector or text';
    let tokens = (args || '').trim().split(/\s+/).filter(Boolean);
    const gone = tokens.includes('--gone');
    tokens = tokens.filter(t => t !== '--gone');
    let seconds = WAIT_DEFAULT;
    if (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1])) seconds = Number(tokens.pop());
    if (!tokens.length || seconds < 1 || seconds > WAIT_MAX) throw new Error(`${usage} (1-${WAIT_MAX})`);
    const timeout = seconds * 1000;
    // Said plainly, not as Playwright's call log.
    const plainly = message => error => { throw /Timeout \d+ms exceeded/.test(error.message) ? new Error(message) : error; };
    const kind = tokens[0];
    if (kind === 'load' && tokens.length === 1) {
      if (gone) throw new Error(usage);
      return waitForLoad(timeout);
    }
    if ((kind === 'text' || kind === 'request') && tokens.length > 1) {
      const what = tokens.slice(1).join(' ').replace(/^(["'])(.*)\1$/, '$2').replace(/\\"/g, '"');
      if (kind === 'request') {
        if (gone) throw new Error(usage);
        return waitForRequest(what, timeout);
      }
      if (gone) return waitGone(state.page.getByText(what), what, timeout);
      await state.page.getByText(what).first().waitFor({ state: 'visible', timeout }).catch(plainly(`No visible text matches ${what} within ${seconds}s`));
      out.log(`Visible: ${what}`);
      return;
    }
    const selector = toSelector(unquote(tokens.join(' ')));
    if (gone) return waitGone(state.page.locator(selector), tokens.join(' '), timeout);
    await state.page.waitForSelector(selector, { state: 'attached', timeout }).catch(plainly(`No element matches ${tokens.join(' ')} within ${seconds}s`));
    out.log(`Found: ${tokens.join(' ')}`);
  },

  async sleep(args) {
    if (!args || !/^\d+$/.test(args) || Number(args) > 3600000) throw new Error('Usage: sleep <ms> (maximum 3600000)');
    await state.page.waitForTimeout(Number(args));
    out.log(`Slept ${args}ms`);
  },

  // A stopped upstream does not reach the browser as a failure: the dev proxy
  // holds the request open instead of refusing it. Cutting the connection at
  // the browser is what a visitor's wifi or VPN dropping looks like to the page.
  async network(args) {
    const words = (args || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const setting = networkChanged.get(state.page);
    if (!words.length) {
      out.log(`The selected tab's network is ${setting ? networkText(setting) : 'on'}.`);
      if (setting) out.log(hints([['network on', 'restore it']]));
      else out.log(hints([['network off', 'cut it, like dropped wifi'], ['network slow [<ms> [<kbps>]]', `slow it (default ${networkText(SLOW_DEFAULT).slice(6, -1)})`]]));
      return;
    }
    const [how, ...rest] = words;
    if ((how === 'on' || how === 'off') && !rest.length) {
      await setNetwork(state.page, how === 'on' ? null : { offline: true });
      out.log(`The selected tab's network is ${how}`);
      return;
    }
    const usage = `Usage: network [on | off | slow [<latency-ms> [<kbps>]]] (latency up to ${SLOW_LATENCY_MAX}ms)`;
    if (how !== 'slow' || rest.length > 2 || !rest.every(w => /^\d+$/.test(w))) throw new Error(usage);
    const [latency, kbps] = rest.map(Number);
    if (latency > SLOW_LATENCY_MAX || kbps === 0) throw new Error(usage);
    const slow = rest.length ? { latency, down: kbps || SLOW_DEFAULT.down, up: kbps || SLOW_DEFAULT.up } : SLOW_DEFAULT;
    await setNetwork(state.page, slow);
    out.log(`The selected tab's network is ${networkText(slow)}`);
  },

  // Fulfilled inside the browser, so the page's own code handles the fake
  // exactly as a real response and the request never reaches the network.
  async route(args) {
    const trimmed = (args || '').trim();
    if (!trimmed) return listRoutes();
    const off = /^off(?:\s+(\S+))?$/.exec(trimmed);
    if (off) return removeRoutes(off[1]);
    const usage = 'Usage: route <url-glob> <status> <json-body> | route <url-glob> patch <json> | route <url-glob> delay <seconds> | route <url-glob> abort | route off <url-glob>|--all';
    const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed);
    if (!match) throw new Error(usage);
    const [, glob, how, rest] = match;
    const route = routeKind(how, rest, usage);
    const routes = routesFor(state.page);
    const previous = routes.get(glob);
    if (previous) await state.page.unroute(glob, previous.handler);
    const handler = async r => {
      const req = r.request();
      const tag = () => { const id = requestEntries.get(req)?.id; return `${id ? `#${id} ` : ''}${req.method()} ${req.url()}`; };
      try {
        await route.handle(r, req, tag);
      } catch (error) {
        // Aborted, never continued: a request meant to be changed must not reach the page as it was.
        await r.abort().catch(() => {});
        out.notice(`Route failed: ${tag()} — ${error.message}; the request was aborted`);
      }
    };
    await state.page.route(glob, handler);
    routes.set(glob, { text: route.text, handler });
    out.log(`${previous ? 'Replaced' : 'Routed'}: ${glob} -> ${route.text}`);
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
    // The numbers skip what is hidden; say so, or they look like requests went missing.
    const first = matches[0].id;
    const last = matches[matches.length - 1].id;
    // With a filter, the numbers skip what does not match too, so the count would mislead.
    const hidden = everything || filter ? 0 : log.filter(e => e.id > first && e.id < last && !shown.includes(e)).length;
    if (hidden) out.log(`(${hidden} hidden between these: images, fonts, stylesheets, media and extension requests; requests --all shows them)`);
  },

  async body(args, all) {
    const match = /^#?(\d+)$/.exec((args || '').trim());
    if (!match) throw new Error('Usage: body <#> (the number from requests)');
    const id = Number(match[1]);
    const entry = (recentLogs.get(state.page) || []).find(e => e.id === id);
    if (!entry) throw new Error(`No request #${id} on the selected tab; requests lists them`);
    // A fake is marked answered before the browser hands over its response.
    for (let waited = 0; !entry.response && /(?:faked|patched)$/.test(entry.status) && waited < 2000; waited += 50) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!entry.response) throw new Error(`#${id} has no response${entry.status === 'pending' ? ' yet' : ` (${entry.status})`}`);
    // Not withTimeout: its "timed out" error would disconnect the REPL, and
    // reading a body cannot have changed anything.
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`did not arrive within ${BODY_TIMEOUT / 1000}s`)), BODY_TIMEOUT); });
    let buffer;
    try { buffer = await Promise.race([entry.response.body(), late]); }
    // Playwright's reason ends in advice for its own API ("Read response.body() before..."), so only its first line is kept.
    catch (error) { throw new Error(`The body of #${id} is not available: ${String(error.message).split('\n')[0]} (the browser drops bodies, e.g. after the tab navigates)`); }
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
    const [sub, ...flags] = arg.split(/\s+/);
    if (sub === 'on' && flags.every(f => f === '--changes' || f === '--live')) {
      const changes = flags.includes('--changes');
      const live = flags.includes('--live');
      await startWatching(state.page, changes, live);
      out.log(`Watching the selected tab: clicks, typing, form changes, submits and navigations${changes ? ', and what each changed on screen' : ''} (typed values are not recorded)`);
      out.log(live ? 'Each step prints here once it settles; watch shows them again.' : 'watch shows what it has recorded; watch on --live also prints each step here as it happens.');
      return;
    }
    if (arg === 'off') {
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

  async dialog(args) {
    out.log(await dialogCommand(args));
  },

  async modes(args) {
    const arg = (args || '').trim();
    if (!arg) return listModes();
    if (arg !== 'off') throw new Error('Usage: modes [off]');
    await allModesOff();
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
onShutdown(resetEmulations);

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
    if (command === 'network') return match(['on', 'off', 'slow']);
    if (command === 'emulate') return match([...EMULATE_KINDS, 'off']);
    if (command === 'wait') return match(['text', 'request', 'load']);
    if (command === 'modes') return match(['off']);
    if (command === 'dialog') return match(['accept', 'dismiss']);
    if (command === 'watch') return match(['on', 'off', 'new', '--all']);
    if (command === 'capture') return match(['on', 'off']);
    if (command === 'route') return match(['off']);
  }
  if (words.length >= 3 && command === 'watch' && words[1] === 'on') return match(['--changes', '--live'].filter(f => !words.slice(2, -1).includes(f)));
  if (words.length === 3 && command === 'capture' && words[1] === 'on') return match(['requests', 'console']);
  if (words.length === 3 && command === 'emulate' && EMULATE_KINDS.includes(words[1])) return match(['off']);
  if (words.length === 3 && command === 'route' && words[1] === 'off') return match(['--all', ...(state.page ? routesFor(state.page).keys() : [])]);
  return [[], current];
}

module.exports = { commands, dialogCommand, listTabs, openTab, activeModes, watchPage, complete, compactSnapshot, grepSnapshot, summarizeChanges, scrubEditable, clock };
