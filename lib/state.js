// Session state shared by the entry point, the runner, and the commands, plus
// the shutdown that ends the session.
const out = require('./output');

const SHUTDOWN_TIMEOUT = 5000;

const state = {
  browser: null,
  // The client whose command runs now: null for the prompt and senders without
  // a name, who share one selected tab, as before clients had names.
  client: null,
  rl: null,
  promptBase: 'pw> ',
  // The browser the REPL is connected to, and whether --launch started it.
  cdpUrl: null,
  launched: false,
  stopping: false,
  connectionLost: false,
  shutdownFailed: false,
  // The folder of a socket of its own, where its screenshots go.
  ownDir: null,
};

// What each client has selected and when its commands ran: state.page and the
// rest read and write the running client's, so commands need not know.
const PER_CLIENT = { page: null, previousPage: null, tabListing: [], previousCommandAt: 0, currentCommandAt: 0 };
const clients = new Map();

function clientRecord(name = state.client) {
  if (!clients.has(name)) clients.set(name, { ...PER_CLIENT, tabListing: [] });
  return clients.get(name);
}

for (const key of Object.keys(PER_CLIENT)) {
  Object.defineProperty(state, key, { enumerable: true, get: () => clientRecord()[key], set: value => { clientRecord()[key] = value; } });
}

// Runs fn as the named client. Commands run one at a time, so this is safe.
async function asClient(name, fn) {
  const previous = state.client;
  state.client = name || null;
  try { return await fn(); } finally { state.client = previous; }
}

const cleanups = [];
const exitWaits = [];
let shutdownPromise = null;

function withTimeout(promise, label, duration = SHUTDOWN_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), duration);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function onShutdown(fn) {
  cleanups.push(fn);
}

// Things to finish before the process exits, e.g. answers still being sent.
function onBeforeExit(fn) {
  exitWaits.push(fn);
}

async function beforeExit() {
  await Promise.all(exitWaits.map(fn => fn()));
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  state.stopping = true;
  shutdownPromise = (async () => {
    // Some undo what the REPL changed in the browser, so they finish first.
    await withTimeout(Promise.all(cleanups.map(async fn => fn())), 'Cleanup').catch(() => {});
    if (state.browser) {
      try { await withTimeout(state.browser.close(), 'Chromium shutdown'); }
      catch (error) { state.shutdownFailed = true; process.exitCode = 1; out.error(`Could not confirm Chromium shutdown: ${error.message}`); }
    }
  })();
  return shutdownPromise;
}

module.exports = { state, clientRecord, asClient, withTimeout, onShutdown, onBeforeExit, beforeExit, shutdown, SHUTDOWN_TIMEOUT };
