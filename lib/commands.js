const path = require('path');
const fs = require('fs');
const { state, clientRecord, withTimeout, onShutdown, shutdown } = require('./state');
const out = require('./output');
const HELP = require('./help');
const { takeOptions } = require('./cli-names');
const { devices } = require('playwright-core');
const { toSelector, unquote, splitSelector, REF, keyName } = require('./syntax');

const { printOutput, OUTPUT_LIMIT } = out;

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
    page, label, startedAt, events, handlers, wake: null, owner: state.client,
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

// Everything the REPL keeps about a tab, in one record per page. A WeakMap, so a closed page's
// record goes with it: the shutdown cleanups walk the browser's pages instead of the records.
//   dialogHandled  its dialog handler is on
//   session        the CDP session kept for it (a promise)
//   drawing        it is kept drawing in the background
//   targetId       its CDP target id
//   networkEnabled its CDP session has Network on
//   network        how its network is changed: { offline: true }, or slowed { latency, down, up }
//                  (ms, kbps), with the owner
//   emulation      what emulate changed: { device, scheme, locale, timezone }, each unset when off,
//                  with the owner
//   routes         Map(glob -> { status, body, handler, owner })
//   log            its recent requests (requests)
//   consoleLog     its recent console messages and page errors (console)
//   loadedAt       when its page last fired its load event
//   bodiesDurable  the browser keeps its response bodies after it navigates
const tabStates = new WeakMap();

function tabState(p) {
  // No tab selected: nothing is kept, as a WeakMap's get finds nothing.
  if (!p) return {};
  let record = tabStates.get(p);
  if (!record) tabStates.set(p, record = {});
  return record;
}

// page -> its open dialog. The page, and every command that reads it, waits
// until the dialog is answered, in the browser or with the dialog command.
const openDialogs = new Map();

function ensureDialogHandler(p) {
  if ('dialogHandled' in tabState(p)) return;
  tabState(p).dialogHandled = true;
  p.on('dialog', dialog => {
    openDialogs.set(p, dialog);
    out.notice(`Dialog [${dialog.type()}]: ${String(dialog.message()).slice(0, OUTPUT_LIMIT)}`);
    out.notice('It waits to be answered in the browser, or with dialog accept [text] | dialog dismiss; until then the page, and commands that read it, wait too.');
  });
  p.on('close', () => openDialogs.delete(p));
}

// Runs ahead of the command queue (see runner.js), so it still works while
// commands wait on the dialog; it returns its output rather than printing it.
async function dialogCommand(args, selected = state.page) {
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
  const page = openDialogs.has(selected) ? selected : openDialogs.size === 1 ? [...openDialogs.keys()][0] : null;
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
  const device = tabState(state.page).emulation?.device;
  if (device) {
    const { width, height } = devices[device].viewport;
    // A page with no viewport meta tag is laid out as on a desktop, and the phone shows it shrunk.
    const laidOut = await state.page.evaluate(() => innerWidth).catch(() => null);
    const wider = laidOut && laidOut > width ? `; the page lays out ${laidOut} wide, shown shrunk: it has no viewport meta tag` : '';
    return `${width}x${height} (emulate mobile: ${device}${wider})`;
  }
  const set = state.page.viewportSize();
  if (set) return `${set.width}x${set.height} (set with viewport)`;
  const size = await state.page.evaluate(() => `${innerWidth}x${innerHeight}`).catch(() => null);
  return size ? `${size} (the window's size)` : 'unknown';
}

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

const SCREENSHOT_DELAY_MAX = 60;

function nextScreenshotPath(name) {
  const filename = name ? `screenshot-${name}` : `screenshot-${Date.now()}`;
  // A REPL on a socket of its own keeps its screenshots next to it, as its log is.
  return path.join(process.env.PW_SCREENSHOT_DIR || state.ownDir || '/tmp', `${filename}.png`);
}

// Per page: a CDP session's emulation applies to the page it is attached to
// and resets, in part, when it detaches, so one is kept for each tab.
function keptSession(p) {
  if (!('session' in tabState(p))) tabState(p).session = p.context().newCDPSession(p).catch(error => { delete tabState(p).session; throw error; });
  return tabState(p).session;
}

// Chrome all but stops drawing a tab that is not in front once it has had
// input (about a frame a second), and Playwright waits for frames to see an
// element hold still before acting on it, so each click in a tab opened in the
// background took 1-2s. A screencast keeps the tab drawing without bringing it
// to the front, for as long as the REPL runs (the throttle is back within
// seconds of stopping it). Its frames are tiny and rare; the cost is that the
// tab renders at full rate, as if in front, an animation or a video included.
async function keepDrawing(p) {
  if ('drawing' in tabState(p)) return;
  tabState(p).drawing = true;
  try {
    const session = await keptSession(p);
    session.on('Page.screencastFrame', frame => session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {}));
    await session.send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 8, maxHeight: 8, everyNthFrame: 60 });
  } catch {
    // Only slower without it.
    delete tabState(p).drawing;
  }
}

// DevTools' "Slow 4G".
const SLOW_DEFAULT = { latency: 563, down: 1440, up: 675 };
const SLOW_LATENCY_MAX = 10000;

// setting null restores the network.
async function setNetwork(p, setting) {
  const session = await keptSession(p);
  if (!('networkEnabled' in tabState(p))) { await session.send('Network.enable'); tabState(p).networkEnabled = true; }
  await session.send('Network.emulateNetworkConditions', {
    offline: !!setting?.offline,
    latency: setting?.latency || 0,
    // kbps to bytes per second; -1 is no limit.
    downloadThroughput: setting?.down ? setting.down * 125 : -1,
    uploadThroughput: setting?.up ? setting.up * 125 : -1,
  });
  if (setting) tabState(p).network = { ...setting, owner: state.client }; else delete tabState(p).network;
}

function networkText(setting) {
  return setting.offline ? 'off (offline)' : `slow (${setting.latency}ms latency, ${setting.down} kbps down, ${setting.up} kbps up)`;
}

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

// A screenshot of an emulated phone, taken by Chrome as it draws it. Playwright's own sizes the page
// again for the shot, and a page with no viewport meta tag, laid out wider than the phone and shown
// shrunk, comes out drawn small in a corner of a mostly blank image. One image pixel per CSS pixel.
async function deviceShot(device, { ref, full, type }) {
  const session = await keptSession(state.page);
  let clip = null;
  if (ref) {
    const selector = toSelector(ref);
    const box = await onElement(selector, async () => {
      const locator = state.page.locator(selector);
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
      return locator.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; });
    });
    clip = box;
  }
  // Measured after scrolling to the element, if any.
  const { cssVisualViewport: view, cssContentSize: content } = await session.send('Page.getLayoutMetrics');
  // At the size the phone shows it: a page laid out wider than the phone is shown shrunk (view.scale).
  const scale = view.scale / devices[device].deviceScaleFactor;
  if (clip) clip = { ...clip, scale };
  if (full) clip = { x: 0, y: 0, width: content.width, height: content.height, scale };
  if (!clip) clip = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale };
  // Beyond the visible area, Chrome lays the page out again at its whole size for the shot, which
  // someone looking at it would see move: only for --full, and an element that does not fit.
  const inView = clip.x >= view.pageX && clip.y >= view.pageY && clip.x + clip.width <= view.pageX + view.clientWidth && clip.y + clip.height <= view.pageY + view.clientHeight;
  const { data } = await session.send('Page.captureScreenshot', { format: type, clip, captureBeyondViewport: full || (!!ref && !inView) });
  return Buffer.from(data, 'base64');
}

// Sends only what changed. Chrome takes the user agent and the languages
// together, so a change to either sends both.
function deviceMetrics(session, name) {
  const d = devices[name];
  return session.send('Emulation.setDeviceMetricsOverride', {
    width: d.viewport.width, height: d.viewport.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.isMobile,
    screenWidth: d.screen?.width || d.viewport.width, screenHeight: d.screen?.height || d.viewport.height,
  });
}

async function setEmulation(p, next) {
  const session = await keptSession(p);
  const previous = tabState(p).emulation || {};
  const send = (method, params) => session.send(method, params);
  if (next.device !== previous.device) {
    const d = devices[next.device];
    if (d) {
      await deviceMetrics(session, next.device);
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
  if (emulatedKinds(next).length) tabState(p).emulation = { ...next, owner: state.client }; else delete tabState(p).emulation;
}

function showEmulation() {
  const e = tabState(state.page).emulation;
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
  const pages = state.browser.contexts().flatMap(c => c.pages()).filter(p => 'emulation' in tabState(p) && !p.isClosed());
  await Promise.all(pages.map(p => setEmulation(p, {}).catch(() => {})));
}

// Playwright routes are registered per page, so the listing is too.
const ROUTE_PREVIEW = 80;

function routesFor(p) {
  if (!('routes' in tabState(p))) tabState(p).routes = new Map();
  return tabState(p).routes;
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
    // JSON unless its type is given, so a typo in the JSON is not served as text.
    const typed = /^--content-type=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)(?:\s+([\s\S]*))?$/.exec(rest || '');
    const body = typed ? typed[2] || '' : rest || '';
    if (!typed && body) {
      try { JSON.parse(body); } catch (error) {
        throw new Error(`Body is not valid JSON: ${error.message}; for another kind, give its type: route <url-glob> <status> --content-type=text/plain <body>`);
      }
    }
    // Quoted when it has a parameter: --content-type="text/html; charset=utf-8".
    const contentType = typed ? unquote(typed[1]) : body ? 'application/json' : undefined;
    const preview = body.length > ROUTE_PREVIEW ? `${body.slice(0, ROUTE_PREVIEW)}…` : body;
    return {
      text: `${status}${typed ? ` (${contentType})` : ''}${preview ? ` ${preview}` : ''}`,
      async handle(r, req, tag) {
        markChanged(req, status, 'faked');
        await r.fulfill({ status, contentType, body });
        out.notice(`Faked: ${tag()} -> ${status}`);
      },
    };
  }
  if (how === 'patch') {
    if (!rest) throw new Error(usage);
    // Anything but an object replaces the whole body, as RFC 7386 has it: the way to change an array.
    const patch = parseJson(rest, 'Patch');
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
    ['route <url-glob> <status> [json-body]', 'answer it with this status and JSON'],
    ['route <url-glob> <status> --content-type=<type> <body>', 'or with a body of another type'],
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
// Tabs this REPL opened with tab new.
const openedTabs = new WeakSet();
// page -> the client that opened it (null: the prompt, or a sender without a name).
const tabOwners = new WeakMap();
// The tab the REPL opened for its start URL, which tab marks: in a kept profile it sits among restored tabs.
const startTabs = new WeakSet();

function clipText(text) {
  return text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT)}…` : text;
}

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

function ensureRecentLog(p) {
  if ('log' in tabState(p)) return;
  const log = [];
  const logs = [];
  let nextId = 1;
  let newDocument = false;
  tabState(p).log = log;
  tabState(p).consoleLog = logs;
  p.on('request', req => {
    let navigation = false;
    try { navigation = req.isNavigationRequest() && req.frame() === p.mainFrame(); } catch {}
    const entry = { id: nextId++, t: Date.now(), method: req.method(), url: req.url(), type: req.resourceType(), status: 'pending', ms: null, response: null, navigation };
    if (navigation) newDocument = true;
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
      const status = changedRequests.has(req) ? `${res.status()} ${changedRequests.get(req)}` : String(res.status());
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

// Tabs whose watch on --next-tab is still starting: the page can load before it is ready.
const startingWatches = new WeakSet();

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
  if (!entry || !res || !(watches.get(p)?.on || startingWatches.has(p)) || WATCH_HIDDEN_TYPES.has(entry.type)) return;
  const headers = res.headers();
  if (!TEXT_BODY.test(headers['content-type'] || '') || Number(headers['content-length']) > KEPT_BODY_MAX) return;
  try {
    const buffer = await res.body();
    if (buffer.length <= KEPT_BODY_MAX) entry.kept = buffer;
  } catch {}
}
const TYPING_BACKDATE_MAX = 60000;
const PAGE_ACTIONS = new Set(['click', 'check', 'uncheck', 'select', 'fill', 'type', 'press', 'submit']);
// page -> its binding's record function; the binding is added once per tab.
const watchBindings = new WeakMap();
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
    // accepted from it, as plain strings; navigations come from here. A CDP
    // binding of its own, not Playwright's exposeBinding: every Playwright
    // client shares that one, so another tool attached to the browser would
    // answer each call with a "not exposed" error thrown into the page.
    if (!watchBindings.has(p)) {
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
  startingWatches.add(p);
  keepBodiesDurable(p);
  startWatching(p, want.changes, want.live).then(() => {
    startingWatches.delete(p);
    watches.get(p).owner = want.client;
    const onNavigate = frame => {
      if (frame !== p.mainFrame() || BROWSER_PAGE.test(frame.url())) return;
      const url = frame.url();
      p.off('framenavigated', onNavigate);
      const watch = watches.get(p);
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
    startingWatches.delete(p);
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
  if (watches.get(p)?.on) modes.push('watch');
  const network = tabState(p).network;
  if (network) modes.push(network.offline ? 'network:off' : 'network:slow');
  const emulated = emulatedKinds(tabState(p).emulation);
  if (emulated.length) modes.push(`emulate:${emulated.join(',')}`);
  const routes = tabState(p).routes?.size;
  if (routes) modes.push(`routes:${routes}`);
  if (cap && cap.page === p) modes.push('capture');
  return modes;
}

function listModes() {
  const all = state.browser.contexts().flatMap(c => c.pages());
  state.tabListing = all.slice();
  const on = all.map((p, i) => [p, i, activeModes(p)]).filter(([, , modes]) => modes.length);
  if (nextTab) out.log(`${waitingText()} (watch off stops waiting)${nextTab.client ? `, for ${nextTab.client}` : ''}${on.length ? '\n' : ''}`);
  if (!on.length && nextTab) return;
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
  const watch = watches.get(p);
  if (watch?.on) owners.push([watch.owner ?? null, 'watch']);
  const network = tabState(p).network;
  if (network) owners.push([network.owner ?? null, network.offline ? 'network:off' : 'network:slow']);
  const emulated = tabState(p).emulation;
  if (emulated) owners.push([emulated.owner ?? null, 'emulate']);
  for (const [glob, route] of tabState(p).routes || []) owners.push([route.owner ?? null, `route ${glob}`]);
  if (cap && cap.page === p) owners.push([cap.owner ?? null, 'capture']);
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
  if (nextTab && ours(nextTab.client)) { nextTab = null; any = true; out.log('Stopped waiting to watch a new tab'); }
  // A tab that fails (e.g. it crashed) must not keep the others' modes on.
  for (const p of all) {
    const done = [];
    let problem = null;
    try {
      const watch = watches.get(p);
      if (watch?.on && ours(watch.owner)) { stopWatching(p, watch); done.push('watch off'); }
      if (cap && cap.page === p && ours(cap.owner)) { endCapture(); done.push('capture off (capture shows it)'); }
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

const MODIFIERS = ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'];

// click <selector> [button] [--modifiers=<keys>], as playwright-cli's click
// takes them. The button is read only after a ref or a quoted selector, so
// click text=Turn right is still one selector.
function clickArgs(args, usage) {
  // Found outside quotes only, so a quoted selector keeps whatever is in it.
  const { found, rest: text } = takeOptions((args || '').trim(), { modifiers: 'value' });
  const modifiers = found.flatMap(o => (o.value || '').split(',').filter(Boolean).map(keyName));
  const unknown = modifiers.find(m => !MODIFIERS.includes(m));
  if (unknown) throw new Error(`Not a modifier: ${unknown}; they are ${MODIFIERS.join(', ')}`);
  const parsed = splitSelector(text);
  const button = parsed && /^(?:left|right|middle)$/.test(parsed.rest || '') && (REF.test(parsed.word) || /^["']/.test(text)) ? parsed.rest : null;
  const selector = button ? parsed.selector : soleSelector(text, usage);
  const options = { ...(button ? { button } : {}), ...(modifiers.length ? { modifiers } : {}) };
  return { selector, shown: args.trim(), options };
}

// A trailing --submit, as playwright-cli's fill and type take: Enter afterwards.
function submitFlag(args) {
  if (/(?:^|\s)--submit\s/.test((args || '').trim())) throw new Error('--submit goes at the end of the line');
  const match = /^([\s\S]*?)\s+--submit$/.exec((args || '').trim());
  return match ? { args: match[1], submit: true } : { args, submit: false };
}

function selectorAndValue(args, usage, example) {
  const parsed = splitSelector(args);
  if (!parsed || parsed.rest === undefined) {
    throw new Error(`Usage: ${usage}, e.g. ${example}; quote a selector with spaces: "text=Your name"`);
  }
  return { selector: parsed.selector, value: unquote(parsed.rest), shown: parsed.word };
}

// An element that never appeared is said plainly, not as Playwright's call
// log, and so is one that timed out: its call log (dozens of lines of retries) goes
// to the REPL's pane and log only. A ref that no longer matches usually means the page
// changed since the snapshot it came from.
async function onElement(selector, action) {
  try {
    return await action();
  } catch (error) {
    const message = String(error.message || '').replace(/\x1b\[[0-9;]*m/g, '');
    if (/strict mode violation/.test(message)) throw error;
    const ref = selector.startsWith('aria-ref=') ? selector.slice(9) : null;
    const staleRef = ref ? `\n${ref} is a snapshot ref; if the page changed since that snapshot, take a new one.` : '';
    const timeout = /Timeout (\d+)ms exceeded/.exec(message);
    if (timeout && /waiting for locator/.test(message) && !/resolved to/.test(message)) {
      throw new Error(`No element matches ${ref || selector} (waited ${timeout[1] / 1000}s)${staleRef}`);
    }
    if (!timeout) { error.message += staleRef; throw error; }
    console.error(`Playwright's call log:\n${message}`);
    // Found, so the ref is not stale: no hint.
    const summary = new Error(`Timed out after ${timeout[1] / 1000}s on ${ref || selector}: ${lastBlocker(message)} (its call log is in the REPL's pane or log)`);
    // Worked out from the whole log: the summary no longer says whether the element was found.
    summary.uncertain = !/waiting for locator/.test(message) || /resolved to/.test(message);
    throw summary;
  }
}

// What last stopped the action, from Playwright's call log: the element that took the click,
// or the check the element kept failing.
function lastBlocker(log) {
  const lines = log.split('\n').map(line => line.trim().replace(/^-\s*/, ''));
  const line = lines.reverse().find(l => /intercepts pointer events|element is not |element is outside|not attached|detached/.test(l));
  if (!line) return 'it never became ready to act on';
  return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}

// Where a match stands for a click: hidden elements are left out before this. Tested in
// its own frame, at its centre, and only when that is in view: scrolling each one to test
// it would move a page someone may be looking at.
function hitTest(el) {
  if (window !== window.top) return { kind: 'unchecked' };
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { kind: 'unchecked' };
  let top = document.elementFromPoint(x, y);
  while (top?.shadowRoot) {
    const inner = top.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === top) break;
    top = inner;
  }
  for (let n = top; n; n = n.parentNode || n.host) if (n === el) return { kind: 'hit' };
  const name = e => {
    const classes = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    return `<${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${classes.map(c => `.${c}`).join('')}>`;
  };
  return { kind: 'covered', by: top ? name(top) : 'nothing (off the page)' };
}

// Playwright acts on the first match and retries it until it times out, even when that one is
// hidden or under an overlay and a later one could be used. With several matches, this picks
// the first visible one that is not covered (or not checkable here, which Playwright then
// checks as it acts), waiting for one as Playwright waits; with none it fails before acting,
// saying why. The chosen element's handle is what is acted on, so the list changing
// meanwhile cannot shift the choice. Null: a ref or a single match, left to Playwright.
async function chooseMatch(selector, timeout) {
  if (selector.startsWith('aria-ref=')) return null;
  const locator = state.page.locator(selector);
  if (await locator.count() <= 1) return null;
  const deadline = Date.now() + timeout;
  let seen = { count: 0, handles: [], results: [] };
  for (;;) {
    const count = await locator.count();
    if (count <= 1 && !seen.handles.length) return null;
    const handles = await locator.filter({ visible: true }).elementHandles();
    const results = await Promise.all(handles.map(h => h.evaluate(hitTest).catch(() => ({ kind: 'gone' }))));
    // In page order: a later match in view must not win over an earlier one Playwright can scroll to.
    const index = results.findIndex(r => r.kind === 'hit' || r.kind === 'unchecked');
    if (index !== -1) {
      await Promise.all(seen.handles.concat(handles.filter((_, i) => i !== index)).map(h => h.dispose().catch(() => {})));
      const all = await locator.elementHandles();
      const position = (await Promise.all(all.map(h => h.evaluate((a, b) => a === b, handles[index])))).indexOf(true);
      await Promise.all(all.map(h => h.dispose().catch(() => {})));
      return { handle: handles[index], position: position + 1, count };
    }
    await Promise.all(seen.handles.map(h => h.dispose().catch(() => {})));
    seen = { count, handles, results };
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const listed = await Promise.all(seen.handles.slice(0, 5).map(async (h, i) => {
    const text = await h.evaluate(el => `<${el.tagName.toLowerCase()}> ${(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)}`).catch(() => '(gone)');
    const r = seen.results[i];
    return `  ${text}: ${r.kind === 'covered' ? `covered by ${r.by}` : 'gone from the page'}`;
  }));
  await Promise.all(seen.handles.map(h => h.dispose().catch(() => {})));
  const hidden = seen.count - seen.handles.length;
  const error = new Error([
    `None of the ${seen.count} matches for ${selector} could be acted on after ${timeout / 1000}s, so nothing was done:`,
    ...listed,
    ...(seen.handles.length > 5 ? [`  and ${seen.handles.length - 5} more like these`] : []),
    ...(hidden ? [`  ${hidden} hidden`] : []),
    'A more specific selector, or a ref from snapshot, picks one; covered ones may be under a dialog or overlay.',
  ].join('\n'));
  error.uncertain = false;
  throw error;
}

function numbers(args, usage) {
  const words = (args || '').trim().split(/\s+/).filter(Boolean);
  if (words.some(w => !/^-?\d+(?:\.\d+)?$/.test(w))) throw new Error(`Usage: ${usage}, in numbers of CSS pixels`);
  return words.map(Number);
}

function mouseButton(args, name) {
  const button = (args || '').trim() || 'left';
  if (!/^(?:left|right|middle)$/.test(button)) throw new Error(`Usage: ${name} [left|right|middle]`);
  return button;
}

// click, dblclick and hover: on the match chooseMatch picks, or as Playwright does.
// A page that renders the chosen element again (as React lists do) replaces it before it is
// acted on; it is chosen again then, as Playwright finds a locator's element again.
async function pointerAction(selector, act, options = {}) {
  const TIMEOUT = 5000;
  const deadline = Date.now() + TIMEOUT;
  const left = () => Math.max(1000, deadline - Date.now());
  for (;;) {
    const chosen = await onElement(selector, () => chooseMatch(selector, left()));
    if (!chosen) {
      // Only counted so far, so the whole time is Playwright's, as it was before.
      await onElement(selector, () => act(state.page, selector, { ...options, timeout: TIMEOUT }));
      return '';
    }
    try {
      await onElement(selector, () => act(chosen.handle, null, { ...options, timeout: left() }));
      return chosen.position === 1 ? '' : ` (match ${chosen.position} of ${chosen.count}; the ones before it are hidden or covered)`;
    } catch (error) {
      if (!/not attached/i.test(error.message) || Date.now() >= deadline) throw error;
    } finally {
      await chosen.handle.dispose().catch(() => {});
    }
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
function notLoaded(navigation) {
  const why = stayedPut(navigation) ? `${navigation.status} (no page to show, so the tab stays where it was)` : navigation.status.startsWith('failed') ? navigation.status : `${navigation.status}, then failed: ${navigation.failed}`;
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
// needle: text to find in any case, or a RegExp.
function grepSnapshot(text, needle) {
  const lower = typeof needle === 'string' ? needle.toLowerCase() : null;
  const matches = line => (lower === null ? needle.test(line) : line.toLowerCase().includes(lower));
  const stack = [];
  const hits = [];
  const label = line => line.trim().replace(/^- /, '').replace(/:$/, '').replace(/^'(.*)'$/, '$1');
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (matches(line)) {
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

// For --regex, as playwright-cli's find --regex and requests --filter take one.
function regexOf(pattern) {
  try { return new RegExp(pattern); } catch (error) { throw new Error(`Not a regular expression: ${error.message}`); }
}

// A pattern without its quotes, and with \" inside them as ", as snapshot
// reads one: other backslashes are the regexp's own (\d).
function patternText(text) {
  return text.replace(/^(["'])(.*)\1$/, '$2').replace(/\\"/g, '"');
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

// True while tab new opens a tab: watch on --next-tab waits for one someone
// else opens, not one a client of the REPL opens for itself.
let opening = false;

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
  openedTabs.add(opened);
  tabOwners.set(opened, state.client);
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
    const notes = [startTabs.has(p) && 'the start URL', tabOwners.get(p) && `opened by ${tabOwners.get(p)}`].filter(Boolean);
    out.log(`${marker} [${i}] ${p.url()}${notes.length ? `  (${notes.join(', ')})` : ''}`);
    out.log(`        ${JSON.stringify(title)}`);
  }
}

// A function written out (el => ..., function (el) {...}), as one expression.
function isFunctionText(text) {
  // Wrapped in parentheses, as (el => el.id) is often written: only when the first one closes at the end.
  const wrapped = /^\s*\(([\s\S]*)\)\s*$/.exec(text);
  if (wrapped && closesAtEnd(text.trim()) && isFunctionText(wrapped[1])) return true;
  if (!/^\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(text)) return false;
  try { new Function(`return (${text}\n);`); return true; } catch { return false; }
}

// Whether the opening parenthesis is matched by the last character, not earlier: (a)(b) is a call.
function closesAtEnd(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') { depth -= 1; if (depth === 0) return i === text.length - 1; }
  }
  return false;
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

  async click(args) {
    const { selector, shown, options } = clickArgs(args, 'click <selector> [left|right|middle] [--modifiers=<key>[,<key>]]');
    const which = await pointerAction(selector, (on, sel, o) => (sel ? on.click(sel, o) : on.click(o)), options);
    out.log(`Clicked: ${shown}${which}`);
  },

  async dblclick(args) {
    const { selector, shown, options } = clickArgs(args, 'dblclick <selector> [left|right|middle] [--modifiers=<key>[,<key>]]');
    const which = await pointerAction(selector, (on, sel, o) => (sel ? on.dblclick(sel, o) : on.dblclick(o)), options);
    out.log(`Double-clicked: ${shown}${which}`);
  },

  async hover(args) {
    const selector = soleSelector(args, 'hover <selector>');
    const which = await pointerAction(selector, (on, sel, o) => (sel ? on.hover(sel, o) : on.hover(o)));
    out.log(`Hovered: ${args.trim()}${which}`);
  },

  // At a point, in CSS pixels from the top left of the tab's viewport, as playwright-cli's are.
  async mousemove(args) {
    const [x, y, extra] = numbers(args, 'mousemove <x> <y>');
    if (y === undefined || extra !== undefined) throw new Error('Usage: mousemove <x> <y>, in CSS pixels from the top left of the viewport');
    await state.page.mouse.move(x, y);
    out.log(`Moved the mouse to ${x}, ${y}`);
  },

  async mousedown(args) {
    const button = mouseButton(args, 'mousedown');
    await state.page.mouse.down({ button });
    out.log(`Pressed the ${button} button`);
  },

  async mouseup(args) {
    const button = mouseButton(args, 'mouseup');
    await state.page.mouse.up({ button });
    out.log(`Released the ${button} button`);
  },

  // Wheel events where the mouse is (mousemove puts it there): a map zooms around that point.
  async mousewheel(args) {
    const [dx, dy, extra] = numbers(args, 'mousewheel <dx> <dy>');
    if (dy === undefined || extra !== undefined) throw new Error('Usage: mousewheel <dx> <dy>, e.g. mousewheel 0 300 scrolls down (negative dy up)');
    await state.page.mouse.wheel(dx, dy);
    out.log(`Turned the wheel by ${dx}, ${dy}`);
  },

  async fill(line) {
    const { args, submit } = submitFlag(line);
    const { selector, value, shown } = selectorAndValue(args, 'fill <selector> <value> [--submit]', 'fill #name Ada Lovelace');
    await onElement(selector, () => state.page.fill(selector, value, { timeout: 5000 }));
    if (submit) await state.page.press(selector, 'Enter', { timeout: 5000 });
    out.log(`Filled${submit ? ' and submitted' : ''}: ${shown}`);
  },

  async type(line) {
    const { args, submit } = submitFlag(line);
    // One word, or one quoted, is typed into the focused element, as playwright-cli's type does.
    const sole = splitSelector(args);
    if (sole && sole.rest === undefined) {
      // Named, since it may not be the element meant; one that takes no text is refused.
      const focused = await state.page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        const editable = el.isContentEditable || el.matches('textarea, input:not([type=checkbox],[type=radio],[type=button],[type=submit],[type=reset],[type=image],[type=file],[type=range],[type=color],[type=hidden])');
        const id = el.id ? `#${el.id}` : el.name ? `[name=${el.name}]` : el.placeholder ? `[placeholder="${el.placeholder}"]` : '';
        return { editable, name: `${el.tagName.toLowerCase()}${id}` };
      });
      const usage = 'type <selector> <text> types into an element, e.g. type #search garden hose';
      if (!focused) throw new Error(`Nothing on the page has focus: ${usage}`);
      if (!focused.editable) throw new Error(`The focused element, ${focused.name}, takes no text: ${usage}`);
      await state.page.keyboard.type(sole.word);
      if (submit) await state.page.keyboard.press('Enter');
      out.log(`Typed into the focused ${focused.name}${submit ? ', and submitted' : ''}`);
      return;
    }
    const { selector, value, shown } = selectorAndValue(args, 'type [<selector>] <text> [--submit]', 'type #search garden hose');
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
    if (submit) await state.page.keyboard.press('Enter');
    out.log(`Typed into${submit ? ' and submitted' : ''}: ${shown}`);
  },

  async press(args) {
    const parsed = splitSelector(args);
    if (!parsed) throw new Error('Usage: press <key> | press <selector> <key>, e.g. press Enter or press #name Enter');
    if (parsed.rest === undefined) {
      await state.page.keyboard.press(keyName(parsed.word));
      out.log(`Pressed: ${keyName(parsed.word)}`);
      return;
    }
    const key = keyName(unquote(parsed.rest));
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
    // playwright-cli's upload <file> answers a file picker a click opened. Here
    // the input is named instead: catching pickers would catch the person's too.
    const usage = 'Usage: upload <selector> <file>..., naming the file input (or the button that opens it) first, e.g. upload e12 ./doc.pdf; quote a path with spaces';
    if (!parsed || parsed.rest === undefined) throw new Error(usage);
    // A path, not a selector; // starts an XPath.
    if (/^(?:\.{1,2}\/|\/(?!\/)|~)/.test(parsed.word) || (!REF.test(parsed.word) && fs.statSync(path.resolve(parsed.word), { throwIfNoEntry: false })?.isFile())) throw new Error(`${parsed.word} is a file, not the input: ${usage.slice(7)}`);
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
      const { listeners: found } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      // Playwright adds its own to window once it has acted on the page; they are not the page's.
      // Told by the script they come from, the one its hit-target check is in.
      const own = new Set(found.filter(l => /^__playwright_/.test(l.type) || /_hitTargetInterceptor/.test(l.handler?.description || '')).map(l => l.scriptId));
      const listeners = found.filter(l => !own.has(l.scriptId));
      const note = found.length > listeners.length ? ` (${found.length - listeners.length} of Playwright's own left out)` : '';
      if (!listeners.length) { out.log(`No event listeners on ${text}${note}`); return; }
      const lines = listeners.map(l => {
        const how = [l.useCapture && 'capture', l.once && 'once', l.passive && 'passive'].filter(Boolean).join(', ');
        const source = l.handler?.description || '';
        // Whole, as written, with its lines indented; or its start on one line, where ↵ marks each
        // line break, so a // comment is seen to end there.
        const text = all
          ? source.split('\n').map((line, i) => (i ? `    ${line}` : line)).join('\n')
          : source.replace(/[ \t]*\r?\n\s*/g, ' ↵ ').replace(/[ \t]+/g, ' ');
        const handler = all || text.length <= 100 ? text : `${text.slice(0, 100)}…`;
        return `${l.type}${how ? ` (${how})` : ''}: ${handler} (line ${l.lineNumber + 1})`;
      });
      printOutput(lines.join('\n'), all);
      if (note) out.log(note.trim());
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
    const usage = 'Usage: screenshot [<ref>] [--full] [--delay|-d <seconds>] [name | --filename=<file>]\nNames may contain letters, digits, underscores, and hyphens.';
    // The file first: a path may be quoted, with spaces in it.
    let file = null;
    const rest = (args || '').replace(/(?:^|\s)--filename(?:=|\s+)("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/, (_, value) => { file = unquote(value); return ' '; });
    const tokens = rest.trim().split(/\s+/).filter(Boolean);
    let full = false;
    let delay = 0;
    let ref = null;
    const names = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      // --full-page and --filename are playwright-cli's.
      if (token === '--full' || token === '--full-page') { full = true; continue; }
      if (token === '--filename' || token.startsWith('--filename=')) throw new Error(usage);
      if (!ref && !names.length && REF.test(token)) { ref = token; continue; }
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
    if (names.length > 1 || (names[0] && !/^[a-zA-Z0-9_-]+$/.test(names[0])) || (file && names.length) || (ref && full)) throw new Error(usage);
    const name = names[0] || null;
    // Counted down out loud so a watcher can time a hover or menu state, and so
    // the wait is distinguishable from a hung command in a tmux capture.
    for (let remaining = delay; remaining > 0; remaining--) {
      out.log(`${remaining}...`);
      await state.page.waitForTimeout(1000);
    }
    // Named after the countdown so a default filename timestamps the capture.
    // A file given is relative to the REPL's folder; pw-repl send makes it the sender's.
    const filepath = file ? path.resolve(file) : nextScreenshotPath(name);
    const type = /\.jpe?g$/i.test(filepath) ? 'jpeg' : 'png';
    // Checked before the tab is brought to the front, which can move someone's view.
    if (fs.existsSync(filepath)) throw new Error(`Screenshot already exists: ${filepath}`);
    if (!fs.existsSync(path.dirname(filepath))) throw new Error(`No folder ${path.dirname(filepath)} to save ${path.basename(filepath)} in`);
    // Chrome does not draw a tab that is not in front, and tabs open in the
    // background, so the tab is brought to the front for the shot.
    await state.page.bringToFront();
    let image;
    const device = tabState(state.page).emulation?.device;
    try {
      if (device) {
        image = await deviceShot(device, { ref, full, type });
      } else if (ref) {
        const selector = toSelector(ref);
        image = await onElement(selector, () => state.page.locator(selector).screenshot({ type, timeout: 5000 }));
      } else {
        image = await state.page.screenshot({ fullPage: full, type });
      }
    } finally {
      // Playwright's screenshot resets the screen size and pixel ratio it
      // finds; an emulated phone's are set again.
      if (device) {
        const session = await keptSession(state.page);
        await session.send('Emulation.clearDeviceMetricsOverride');
        await deviceMetrics(session, device);
      }
    }
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
    const grep = /^--(grep|regex)(?:\s|$)/.exec(rest);
    if (grep) {
      needle = rest.slice(grep[0].length).trim().replace(/^(["'])(.*)\1$/, '$2').replace(/\\"/g, '"');
      if (!needle) throw new Error(`Usage: snapshot [--full] --${grep[1]} <${grep[1] === 'grep' ? 'text' : 'pattern'}>`);
      if (grep[1] === 'regex') needle = regexOf(needle);
      rest = '';
    }
    // Playwright's labels are e5, or frame-prefixed like f1e5 in newer versions.
    const selector = toSelector(rest);
    let raw;
    // A snapshot of one element gives the page new refs, and those of the last whole-page snapshot
    // stop working; so a ref's part is cut from a whole-page snapshot, which keeps them.
    if (REF.test(rest)) {
      const lines = (await state.page.ariaSnapshot({ mode: 'ai', timeout: 5000 })).split('\n');
      const at = lines.findIndex(line => line.includes(`[ref=${rest}]`));
      if (at === -1) throw new Error(`No element matches ${rest}\n${rest} is a snapshot ref; if the page changed since that snapshot, take a new one.`);
      const indent = line => line.length - line.trimStart().length;
      const end = lines.findIndex((line, i) => i > at && indent(line) <= indent(lines[at]));
      raw = lines.slice(at, end === -1 ? undefined : end).map(line => line.slice(indent(lines[at]))).join('\n');
    } else if (selector) {
      raw = await onElement(selector, () => state.page.locator(selector).first().ariaSnapshot({ mode: 'ai', timeout: 5000 }));
    } else {
      raw = await state.page.ariaSnapshot({ mode: 'ai', timeout: 5000 });
    }
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
    if (tabState(state.page).emulation?.device) throw new Error('emulate mobile sets the size of the selected tab; emulate mobile off first');
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
    const current = tabState(state.page).emulation || {};
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
      // As when turned on: the page keeps what it read at load until it loads again.
      if ((what === 'mobile' || what === 'locale') && state.page.url() !== 'about:blank') out.log('The page sees its own user agent, touch and languages again from its next load: reload to see all of it.');
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
    // The page reads these when it loads; the rest applies at once. A blank tab has nothing to reload.
    if ((what === 'mobile' || what === 'locale') && state.page.url() !== 'about:blank') out.log('The page sees its user agent, touch and languages from its next load: reload to see all of it.');
  },

  async wait(args) {
    const usage = 'Usage: wait <selector> | wait text <text> | wait request <url-part|glob> | wait load, with optional [seconds]; --gone for a selector or text';
    let tokens = (args || '').trim().split(/\s+/).filter(Boolean);
    const gone = tokens.includes('--gone');
    tokens = tokens.filter(t => t !== '--gone');
    let seconds = WAIT_DEFAULT;
    // A number last is the seconds, unless it is all there is to wait for: wait text 990.
    const onlyWhat = (tokens[0] === 'text' || tokens[0] === 'request') && tokens.length === 2;
    if (tokens.length > 1 && !onlyWhat && /^\d+$/.test(tokens[tokens.length - 1])) seconds = Number(tokens.pop());
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
    await state.page.waitForSelector(selector, { state: 'visible', timeout }).catch(plainly(`No visible element matches ${tokens.join(' ')} within ${seconds}s`));
    out.log(`Visible: ${tokens.join(' ')}`);
  },

  async sleep(args) {
    if (!args || !/^\d+$/.test(args) || Number(args) > 3600000) throw new Error('Usage: sleep <ms> (maximum 3600000)');
    await state.page.waitForTimeout(Number(args));
    // sleep 3 is easily meant as seconds.
    out.log(Number(args) < 100 ? `Slept ${args}ms (sleep takes milliseconds: sleep ${args}000 is ${args}s)` : `Slept ${args}ms`);
  },

  // A stopped upstream does not reach the browser as a failure: the dev proxy
  // holds the request open instead of refusing it. Cutting the connection at
  // the browser is what a visitor's wifi or VPN dropping looks like to the page.
  async network(args) {
    const words = (args || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const setting = tabState(state.page).network;
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
    // A glob may be quoted, as it is in a shell.
    const off = /^off(?:\s+(\S+))?$/.exec(trimmed);
    if (off) return removeRoutes(off[1] && unquote(off[1]));
    const usage = 'Usage: route <url-glob> <status> [json-body] | route <url-glob> patch <json> | route <url-glob> delay <seconds> | route <url-glob> abort | route off <url-glob>|--all';
    const parsed = splitSelector(trimmed);
    const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(parsed?.rest || '');
    if (!match) throw new Error(usage);
    const glob = parsed.word;
    const [, how, rest] = match;
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
    routes.set(glob, { text: route.text, handler, owner: state.client });
    out.log(`${previous ? 'Replaced' : 'Routed'}: ${glob} -> ${route.text}`);
  },

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

  async watch(args, all) {
    const arg = (args || '').trim();
    const watch = watches.get(state.page);
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
      watches.get(state.page).owner = state.client;
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

  async eval(args, all) {
    if (!args) throw new Error('Usage: eval <js-expression>');
    // eval <function> <ref> calls the function with that element, as playwright-cli's eval does.
    const onRef = /^([\s\S]+?)\s+((?:f\d+)?e\d+)$/.exec(args.trim());
    if (onRef && isFunctionText(unquote(onRef[1]))) {
      const selector = toSelector(onRef[2]);
      const el = await onElement(selector, () => state.page.locator(selector).first().elementHandle({ timeout: 5000 }));
      try {
        // Made from its text by the debugger, as eval is, so a page's CSP cannot
        // refuse it, and in the element's own frame, which may be an iframe.
        const fn = await withTimeout((await el.ownerFrame()).evaluateHandle(unquote(onRef[1])), 'Page evaluation', COMMAND_TIMEOUT);
        try {
          printOutput(await el.evaluate((e, f) => f(e), fn), all);
        } finally {
          await fn.dispose().catch(() => {});
        }
      } finally {
        await el.dispose().catch(() => {});
      }
      return;
    }
    // A function, as playwright-cli's eval takes, is called rather than returned.
    // Only a single expression can be one; statements are evaluated as they are.
    // await at the top level: one expression is run as an async function; statements as DevTools'
    // console runs them (replMode), which gives back the last one's value.
    const compiles = (Kind, body) => { try { new Kind(body); return true; } catch { return false; } };
    const AsyncFunction = (async () => {}).constructor;
    const awaits = /\bawait\b/.test(args) && !compiles(Function, `return (${args}\n);`);
    const single = compiles(awaits ? AsyncFunction : Function, `return (${args}\n);`);
    const call = `const value = (${args}\n); return typeof value === 'function' ? value() : value;`;
    if (awaits && !single && compiles(AsyncFunction, args)) {
      const session = await keptSession(state.page);
      const { result, exceptionDetails } = await withTimeout(session.send('Runtime.evaluate', { expression: args, replMode: true, awaitPromise: true, returnByValue: true }), 'Page evaluation', COMMAND_TIMEOUT);
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      printOutput(result.value !== undefined ? result.value : result.description ?? 'undefined', all);
      return;
    }
    const expression = single ? `(${awaits ? 'async ' : ''}() => { ${call} })()` : args;
    const value = await withTimeout(state.page.evaluate(expression), 'Page evaluation', COMMAND_TIMEOUT);
    // An empty string is shown as one, not as no output at all.
    printOutput(value === '' ? '""' : value, all);
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
    const own = state.browser.contexts().flatMap(c => c.pages()).filter(p => tabOwners.get(p) === state.client);
    if (own.length) out.log(`Tabs you opened are still open: ${own.map(p => p.url()).join(', ')}; tab close <url-part> closes one, or select it and tab close.`);
  },
};

onShutdown(discardCapture);
onShutdown(resetEmulations);

// Hooks every page needs from the moment the REPL sees it.
function watchPage(p) {
  ensureDialogHandler(p);
  ensureRecentLog(p);
  if (nextTab && !opening) watchNewTab(p);
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

module.exports = { commands, cliCommands, needsTab, dialogCommand, listTabs, openTab, startTabs, activeModes, watchPage, complete, compactSnapshot, grepSnapshot, summarizeChanges, scrubEditable, clock };
