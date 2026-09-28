// Runs commands one at a time, whether they come from the prompt or the server.
// A prompt command tagged @<id> reports completion with a marker the caller can wait for.
const readline = require('readline');
const { state, clientRecord, asClient, beforeExit } = require('./state');
const out = require('./output');
const { commands, cliCommands, needsTab, dialogCommand, activeModes } = require('./commands');
const cliNames = require('./cli-names');

// playwright-cli names already explained, per client: each client is told once.
const explained = new Set();

// The line saying what a playwright-cli name is here, the first time its client uses it.
function explain(text, translated, client = state.client) {
  const name = translated.key || text.split(/\s/)[0];
  const key = `${client ?? ''}\0${name}`;
  if (explained.has(key)) return null;
  explained.add(key);
  return `(playwright-cli's ${name} is ${translated.as} here)`;
}

// quit and dialog skip the queue; so do playwright-cli's dialog-accept and dialog-dismiss.
const DIALOG = /^dialog(?:-accept|-dismiss)?(?:\s|$)/;

// A timeout here cannot have changed anything, so it is an ordinary error. Any
// other command that times out may or may not have done what it was sent to
// do; that is reported, and the REPL carries on.
const READ_ONLY = new Set(['info', 'listeners', 'text', 'html', 'attrs', 'count', 'visible', 'links', 'inputs',
  'snapshot', 'screenshot', 'wait', 'sleep', 'requests', 'body', 'console', 'cookies', 'storage', 'capture', 'help']);

// Commands that work with no tab selected.
const NO_TAB_NEEDED = new Set(['tab', 'modes', 'capture', 'dialog', 'help', 'quit', 'tab-select', 'close']);

// Commands that accept --all, right after the command or at the end, to lift the output limit.
const INSPECTION = ['info', 'listeners', 'text', 'html', 'attrs', 'links', 'inputs', 'eval', 'cdp', 'cookies', 'storage', 'capture', 'body', 'console', 'snapshot', 'watch'];

let queue = Promise.resolve();
// The server command running now, so a quit at the prompt can answer it.
let inFlight = null;

function parseInput(line) {
  const trimmed = line.trim();
  const match = /^@([A-Za-z0-9][A-Za-z0-9._-]*)\s+([\s\S]+)$/.exec(trimmed);
  return { text: match ? match[2] : trimmed, token: match ? match[1] : null };
}

function isUncertain(error) {
  const message = error.message || '';
  if (!/timed out|timeout|connection (?:lost|closed)/i.test(message)) return false;
  // Playwright's call log shows whether the element was ever found; if not, nothing was done.
  return !(/waiting for locator/.test(message) && !/resolved to/.test(message));
}

let running = 0;

// True while a command is running: its own output ends with a fresh prompt.
function busy() {
  return running > 0;
}

// A queued command runs as its client; quit and dialog, which skip the queue,
// run as whoever is running, so they never switch the client under a command.
async function execute(text, client, direct = false) {
  running += 1;
  try {
    return direct ? await executeCommand(text) : await asClient(client, () => executeCommand(text));
  } finally {
    running -= 1;
  }
}

async function executeCommand(text) {
  if (state.connectionLost) return { status: 'error', cmd: '' };
  if (!text) return { status: 'ok', cmd: '' };
  const translated = cliNames.translate(text);
  if (translated?.refuse) {
    out.error(`Error: ${translated.refuse}`);
    return { status: 'error', cmd: text.split(/\s/)[0] };
  }
  if (translated) {
    const note = explain(text, translated);
    if (note) out.log(note);
    if (translated.steps) return runSteps(translated);
    text = translated.text;
  }
  const spaceIdx = text.indexOf(' ');
  const cmd = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
  let args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1);
  let all = false;
  if (INSPECTION.includes(cmd) && /^--all(?:\s|$)/.test(args)) { all = true; args = args.slice(5).trimStart(); }
  // At the end too, where the truncation note's reader tends to put it (console 200 --all).
  else if (INSPECTION.includes(cmd) && /(?:^|\s)--all$/.test(args)) { all = true; args = args.slice(0, -5).trimEnd(); }
  // wait request counts responses since the previous command began.
  state.previousCommandAt = state.currentCommandAt;
  state.currentCommandAt = Date.now();
  const run = Object.hasOwn(commands, cmd) ? commands[cmd] : translated && Object.hasOwn(cliCommands, cmd) ? cliCommands[cmd] : null;
  if (!run) {
    out.log(`Unknown command: ${cmd}. Type 'help' for commands.`);
    return { status: 'error', cmd };
  }
  if (!NO_TAB_NEEDED.has(cmd) && needsTab(cmd, args) && (!state.page || state.page.isClosed())) {
    out.error('Error: No tab is selected; select one with tab <index|url-part>, or open one with tab new');
    return { status: 'error', cmd };
  }
  try {
    await run(args, all);
  } catch (e) {
    // Playwright colours its call log; the codes are noise anywhere but a terminal.
    e.message = String(e.message || '').replace(/\x1b\[[0-9;]*m/g, '');
    out.error(`Error: ${e.message}`);
    const uncertain = !READ_ONLY.has(cmd) && isUncertain(e);
    if (uncertain) out.error('Outcome unknown: it timed out after it began acting on the page. Check the page before trying again.');
    return { status: 'error', cmd, uncertain };
  }
  if (cmd === 'quit' && state.shutdownFailed) return { status: 'error', cmd };
  return { status: 'ok', cmd };
}

// A playwright-cli command that is several here, run in turn until one fails.
async function runSteps({ steps, failed }) {
  let result;
  for (const [i, step] of steps.entries()) {
    result = await executeCommand(step);
    if (result.status !== 'ok') {
      if (i && failed) out.error(failed);
      return result;
    }
  }
  return result;
}

// A quit does not wait for the running server command, which may never finish
// once the browser is gone, so its sender is answered now. A read-only command
// changed nothing; any other may or may not have done what it was sent to do.
function answerInterrupted() {
  if (!inFlight) return;
  const flight = inFlight;
  inFlight = null;
  flight.answered = true;
  const cmd = flight.text.split(' ')[0];
  const known = READ_ONLY.has(cmd);
  const note = known ? 'The REPL quit before this command finished.' : 'The REPL quit before this command finished; its outcome is unknown.';
  const output = out.take();
  flight.resolve({ status: 'error', output: output ? `${output}\n${note}` : note, uncertain: !known, interrupted: true });
}

async function handleLine(line, direct = false) {
  const input = parseInput(line);
  const done = status => { if (input.token) out.log(`[[pw-done:${input.token}:${status}]]`); };
  if (state.stopping) return done('error');
  if (/^quit(?:\s|$)/.test(input.text)) answerInterrupted();
  const result = await execute(input.text, null, direct);
  done(result.status);
  if (result.cmd === 'quit') { await beforeExit(); process.exit(process.exitCode || 0); }
  if (!state.stopping) prompt();
}

// The prompt starts with the modes on in the selected tab: (watch network:off) pw>.
function prompt(preserveCursor) {
  if (!state.rl) return;
  const page = clientRecord(null).page;
  const modes = page && !page.isClosed() ? activeModes(page) : [];
  state.rl.setPrompt(`${modes.length ? `(${modes.join(' ')}) ` : ''}${state.promptBase}`);
  state.rl.prompt(preserveCursor);
}

// quit and dialog skip the queue: quit so it works while a long command runs,
// dialog because the commands queued behind a dialog wait for its answer.
function enqueue(line) {
  const text = parseInput(line).text;
  const direct = /^quit(?:\s|$)/.test(text) || DIALOG.test(text);
  if (direct) handleLine(line, true).catch(e => out.error(`Error: ${e.message}`));
  else queue = queue.then(() => handleLine(line)).catch(e => out.error(`Error: ${e.message}`));
}

// Server commands share the prompt's queue and are echoed to the pane, so
// someone watching sees everything an agent does.
// client names the sender: its commands show as [server:<client>] and use its own selected tab.
function submit(text, client = null) {
  if (DIALOG.test(text)) return answerDialog(text, client);
  return new Promise(resolve => {
    queue = queue.then(async () => {
      if (state.stopping) return resolve({ status: 'error', output: 'The REPL is shutting down.' });
      // Printed above whatever the person at the prompt is typing, which is
      // redrawn afterwards rather than broken up.
      if (process.stdout.isTTY) { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); }
      out.log(`[server${client ? `:${client}` : ''}] ${text}`);
      // So the person at the prompt can bring an agent's command back with up-arrow.
      if (state.rl?.history && state.rl.history[0] !== text) {
        state.rl.history.unshift(text);
        state.rl.history.length = Math.min(state.rl.history.length, 1000);
      }
      if (/^quit(?:\s|$)/.test(text)) {
        const output = await out.collect(async () => out.error('Error: quit is only available at the prompt'));
        resolve({ status: 'error', output });
      } else {
        let result;
        const flight = { text, resolve, answered: false };
        inFlight = flight;
        const output = await out.collect(async () => { result = await execute(text, client); });
        if (inFlight === flight) inFlight = null;
        if (!flight.answered) resolve({ status: result.status, output, uncertain: result.uncertain });
      }
      if (!state.stopping) prompt(true);
    }).catch(e => { out.error(`Error: ${e.message}`); resolve({ status: 'error', output: e.message }); });
  });
}

// Outside the queue, and so outside out.collect, whose single sink belongs to
// the command that is waiting on the dialog.
async function answerDialog(text, client) {
  console.log(`[server${client ? `:${client}` : ''}] ${text}`);
  const translated = cliNames.translate(text);
  const note = translated && explain(text, translated, client);
  let result;
  try { result = { status: 'ok', output: await dialogCommand((translated?.text || text).slice(6), clientRecord(client).page) }; }
  catch (error) { result = { status: 'error', output: `Error: ${error.message}` }; }
  if (note) result.output = `${note}\n${result.output}`;
  console.log(result.output);
  if (!state.stopping) prompt(true);
  return result;
}

function drained() {
  return queue;
}

module.exports = { enqueue, submit, answerInterrupted, drained, busy };
