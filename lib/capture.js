// Capturing a tab's requests and console messages together, from now until capture off.
const { state, onShutdown } = require('./state');
const out = require('./output');
const { printOutput } = out;
const { numbers, MAX_EVENT_TEXT, clock, hints } = require('./util');
const { consoleText, requestEntries } = require('./requestlog');

const MAX_CAPTURE_EVENTS = 10000;
const MAX_CAPTURE_TEXT = 400000;

let cap = null;
let lastCapture = null;

// The capture running now, or null, for the modes it counts as.
function currentCapture() {
  return cap;
}

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

onShutdown(discardCapture);

const commands = {
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
};

module.exports = { commands, currentCapture, endCapture };
