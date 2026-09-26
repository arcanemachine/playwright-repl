// Connects to the browser and runs the prompt (and the server with serve).
const { chromium } = require('playwright-core');
const readline = require('readline');
const { state, withTimeout, shutdown, onBeforeExit, beforeExit } = require('./state');
const out = require('./output');
const { listTabs, openTab, watchPage, complete } = require('./commands');
const runner = require('./runner');

// A browser --launch starts has its own address instead.
let CDP_URL = process.env.PW_CDP_URL || 'http://localhost:9222';
const CONNECT_TIMEOUT = 15000;

// What to do about a browser that cannot be reached, rather than the bare socket error.
function connectHelp(error) {
  const reason = String(error.message).split('\n')[0].replace(/^browserType\.connectOverCDP: /, '');
  if (/timeout/i.test(reason)) {
    return `Chromium at ${CDP_URL} answered but did not finish attaching within ${CONNECT_TIMEOUT / 1000}s. A tab with a\ndialog open (alert, confirm) holds this up: answer it or close that tab, then try again.`;
  }
  return `No browser answered at ${CDP_URL} (${reason}).

pw-repl needs a Chromium-based browser (Chrome, Chromium, Edge, ...) started with remote debugging:
  chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/chrome-debug"
  chrome --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-headless
It needs a --user-data-dir of its own: Chrome does not open the port on its default profile.
curl ${CDP_URL}/json/version checks that it answers; PW_CDP_URL points at a browser elsewhere.
Or let pw-repl start a private one for this REPL: pw-repl run --launch (or serve --launch).`;
}

async function start(options) {
  const START_URL = options.startUrl || process.env.PW_START_URL || null;
  if (options.launch) {
    const launched = await require('./launch').launch({ headed: options.headed, extraArgs: options.chromeArgs });
    onBeforeExit(launched.stop);
    CDP_URL = launched.url;
    out.log(`Launched a ${launched.headed ? 'visible' : 'headless'} Chromium of this REPL's own; it stops with the REPL:`);
    out.log(`  ${launched.command}`);
    if (launched.note) out.log(launched.note);
    out.log(`Another REPL reaches it with PW_CDP_URL=${CDP_URL}`);
  }
  state.cdpUrl = CDP_URL;
  state.launched = !!options.launch;
  out.log(`Connecting to ${CDP_URL}...`);
  try { state.browser = await chromium.connectOverCDP(CDP_URL, { timeout: CONNECT_TIMEOUT }); }
  catch (error) { throw new Error(connectHelp(error)); }
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
    void shutdown().then(beforeExit).then(() => process.exit(1));
  });
  out.log('Connected to Chromium via CDP');

  const contexts = state.browser.contexts();
  const pages = contexts.flatMap(c => c.pages());

  // Nothing is selected to begin with: the first tab may be someone else's.
  state.page = null;
  state.tabListing = pages.slice();

  // Hooks first, so the start URL's own requests, logs and dialogs are recorded.
  for (const ctx of contexts) {
    ctx.on('page', watchPage);
    ctx.pages().forEach(watchPage);
  }

  if (START_URL) {
    state.page = await openTab();
    await state.page.goto(START_URL, { waitUntil: 'networkidle', timeout: 15000 });
    out.log(`Opened ${state.page.url()} in a new tab`);
  }

  out.log('');
  await listTabs();
  out.log('');
  if (!state.page) out.log('No tab is selected: tab new [url] opens one of your own, tab <index|url-part> selects one.');
  if (options.serve) await require('./server').serve(options.endpoint);
  // In the background there is no prompt: commands come only through the server.
  if (options.pidFile) {
    require('./background').claimPidFile(options.pidFile);
    out.onIdlePrint({ idle: () => !runner.busy() && !state.stopping, print: text => console.log(text) });
    const e = require('./background').endpointFlag(options.endpoint);
    out.log(`Running in the background: pw-repl attach${e} to use it, pw-repl stop${e} to stop it.`);
    return;
  }
  if (!options.serve && !process.env.TMUX) {
    out.log('Tip: run it in a tmux session named playwright-repl so pw-repl send can reach it, or use pw-repl serve.');
  }
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
  // Input ends with Ctrl-D, or at once when nothing is attached to it (e.g.
  // started in the background), so it says why it stops.
  rl.on('close', () => {
    if (state.stopping) return;
    endPromptLine();
    out.error('Input ended; disconnecting.');
    runner.drained().then(() => shutdown(), () => shutdown())
      .then(beforeExit).then(() => process.exit(process.exitCode || 0));
  });
  rl.on('SIGINT', stop);
}

// Ctrl-C and Ctrl-D leave the cursor after the prompt; what follows belongs
// on a line of its own.
function endPromptLine() {
  process.stdout.write('\n');
}

// Like quit: a server command still running is answered before the REPL exits.
function stop() {
  endPromptLine();
  runner.answerInterrupted();
  shutdown().then(beforeExit).then(() => process.exit(process.exitCode || 0));
}

// SIGHUP too: closing the terminal must still remove the server's socket.
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, stop);

module.exports = { start: options => start(options).catch(e => { out.error(e.message); shutdown().then(beforeExit).finally(() => process.exit(1)); }) };
