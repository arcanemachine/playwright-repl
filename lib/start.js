// Connects to the browser and runs the prompt (and the server with serve).
const { chromium } = require('playwright-core');
const readline = require('readline');
const { state, withTimeout, shutdown, beforeExit } = require('./state');
const out = require('./output');
const { listTabs, watchPage, complete } = require('./commands');
const runner = require('./runner');

const CDP_URL = process.env.PW_CDP_URL || 'http://localhost:9222';

async function start(options) {
  const START_URL = options.startUrl || process.env.PW_START_URL || null;
  out.log(`Connecting to ${CDP_URL}...`);
  state.browser = await chromium.connectOverCDP(CDP_URL);
  if (state.stopping) {
    try { await withTimeout(state.browser.close(), 'Chromium shutdown'); }
    catch (error) { process.exitCode = 1; out.error(`Could not confirm Chromium shutdown: ${error.message}`); }
    return;
  }
  state.browser.on('disconnected', () => {
    if (state.stopping) return;
    state.connectionLost = true;
    state.stopping = true;
    process.exitCode = 1;
    out.error('Chromium connection lost; queued commands will not run.');
    void shutdown().then(() => process.exit(1));
  });
  out.log('Connected to Chromium via CDP');

  const contexts = state.browser.contexts();
  const pages = contexts.flatMap(c => c.pages());

  state.page = pages[0];
  state.tabListing = pages.slice();

  // Hooks first, so the start URL's own requests, logs and dialogs are recorded.
  for (const ctx of contexts) {
    ctx.on('page', watchPage);
    ctx.pages().forEach(watchPage);
  }

  if (START_URL) {
    if (!state.page) {
      state.page = await contexts[0].newPage();
    }
    await state.page.goto(START_URL, { waitUntil: 'networkidle', timeout: 15000 });
    out.log(`Navigated to: ${state.page.url()}`);
  }

  if (!state.page) {
    state.page = await (contexts[0] || await state.browser.newContext()).newPage();
    out.log('Created new page');
  }

  out.log('');
  await listTabs();
  out.log('');
  if (options.serve) await require('./server').serve(options.endpoint);
  out.log("Run 'help' to see the commands. They act on the selected tab (*).");
  out.log('');

  // The prompt shows whether the command server is on.
  state.promptBase = options.serve ? 'pw[serve]> ' : 'pw> ';
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: state.promptBase,
    completer: complete,
    historySize: 1000,
    removeHistoryDuplicates: true,
  });
  state.rl = rl;
  out.onIdlePrint({
    idle: () => !runner.busy() && !state.stopping,
    print: text => {
      if (process.stdout.isTTY) { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); }
      console.log(text);
      rl.prompt(true);
    },
  });

  rl.prompt();
  rl.on('line', line => {
    // Up-arrow should bring back the command, not the caller's completion id.
    const bare = line.trim().replace(/^@[A-Za-z0-9][A-Za-z0-9._-]*\s+/, '');
    if (bare !== line.trim() && rl.history[0] === line.trim()) {
      rl.history.shift();
      if (bare && rl.history[0] !== bare) rl.history.unshift(bare);
    }
    runner.enqueue(line);
  });
  rl.on('close', () => {
    if (state.stopping) return;
    runner.drained().then(() => shutdown(), () => shutdown())
      .then(() => process.exit(process.exitCode || 0));
  });
  rl.on('SIGINT', stop);
}

// Like quit: a server command still running is answered before the REPL exits.
function stop() {
  runner.answerInterrupted();
  shutdown().then(beforeExit).then(() => process.exit(process.exitCode || 0));
}

// SIGHUP too: closing the terminal must still remove the server's socket.
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, stop);

module.exports = { start: options => start(options).catch(e => { out.error(e.message); shutdown().finally(() => process.exit(1)); }) };
