// Session state shared by the entry point, the runner, and the commands, plus
// the shutdown that ends the session.
const out = require('./output');

const SHUTDOWN_TIMEOUT = 5000;

const state = {
  browser: null,
  page: null,
  previousPage: null,
  tabListing: [],
  rl: null,
  stopping: false,
  connectionLost: false,
  shutdownFailed: false,
  previousCommandAt: 0,
  currentCommandAt: 0,
};

const cleanups = [];
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

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  state.stopping = true;
  shutdownPromise = (async () => {
    cleanups.forEach(fn => fn());
    if (state.browser) {
      try { await withTimeout(state.browser.close(), 'Chromium shutdown'); }
      catch (error) { state.shutdownFailed = true; process.exitCode = 1; out.error(`Could not confirm Chromium shutdown: ${error.message}`); }
    }
  })();
  return shutdownPromise;
}

module.exports = { state, withTimeout, onShutdown, shutdown };
