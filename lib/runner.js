// Runs commands one at a time, whether they come from the prompt or the server.
// A prompt command tagged @<id> reports completion with a marker the caller can wait for.
const readline = require('readline');
const { state, beforeExit } = require('./state');
const out = require('./output');
const { commands, activeModes } = require('./commands');

// A timeout here cannot have changed anything, so it is an ordinary error. Any
// other command that times out may or may not have done what it was sent to
// do; that is reported, and the REPL carries on.
const READ_ONLY = new Set(['info', 'text', 'html', 'attrs', 'count', 'visible', 'links', 'inputs',
  'snapshot', 'screenshot', 'wait', 'sleep', 'requests', 'body', 'console', 'cookies', 'storage', 'capture', 'help']);

// Commands that work with no tab selected.
const NO_TAB_NEEDED = new Set(['tab', 'modes', 'capture', 'help', 'quit']);

// Commands that accept a leading --all to lift the output limit.
const INSPECTION = ['info', 'text', 'html', 'attrs', 'links', 'inputs', 'eval', 'cdp', 'cookies', 'storage', 'capture', 'body', 'console', 'snapshot', 'watch'];

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

async function execute(text) {
  running += 1;
  try {
    return await executeCommand(text);
  } finally {
    running -= 1;
  }
}

async function executeCommand(text) {
  if (state.connectionLost) return { status: 'error', cmd: '' };
  if (!text) return { status: 'ok', cmd: '' };
  const spaceIdx = text.indexOf(' ');
  const cmd = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
  let args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1);
  const all = INSPECTION.includes(cmd) && /^--all(?:\s|$)/.test(args);
  if (all) args = args.slice(5).trimStart();
  // wait request counts responses since the previous command began.
  state.previousCommandAt = state.currentCommandAt;
  state.currentCommandAt = Date.now();
  if (!Object.hasOwn(commands, cmd)) {
    out.log(`Unknown command: ${cmd}. Type 'help' for commands.`);
    return { status: 'error', cmd };
  }
  if (!NO_TAB_NEEDED.has(cmd) && (!state.page || state.page.isClosed())) {
    out.error('Error: No tab is selected; select one with tab <index|url-part>, or open one with tab new');
    return { status: 'error', cmd };
  }
  try {
    await commands[cmd](args, all);
  } catch (e) {
    out.error(`Error: ${e.message}`);
    const uncertain = !READ_ONLY.has(cmd) && isUncertain(e);
    if (uncertain) out.error('Outcome unknown: it timed out after it began acting on the page. Check the page before trying again.');
    return { status: 'error', cmd, uncertain };
  }
  if (cmd === 'quit' && state.shutdownFailed) return { status: 'error', cmd };
  return { status: 'ok', cmd };
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

async function handleLine(line) {
  const input = parseInput(line);
  const done = status => { if (input.token) out.log(`[[pw-done:${input.token}:${status}]]`); };
  if (state.stopping) return done('error');
  if (/^quit(?:\s|$)/.test(input.text)) answerInterrupted();
  const result = await execute(input.text);
  done(result.status);
  if (result.cmd === 'quit') { await beforeExit(); process.exit(process.exitCode || 0); }
  if (!state.stopping) prompt();
}

// The prompt starts with the modes on in the selected tab: (watch network:off) pw>.
function prompt(preserveCursor) {
  if (!state.rl) return;
  const modes = state.page && !state.page.isClosed() ? activeModes(state.page) : [];
  state.rl.setPrompt(`${modes.length ? `(${modes.join(' ')}) ` : ''}${state.promptBase}`);
  state.rl.prompt(preserveCursor);
}

// quit skips the queue so it still works while a long command is running.
function enqueue(line) {
  const direct = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\s+)?quit(?:\s|$)/.test(line.trim());
  const run = () => handleLine(line);
  if (direct) run().catch(e => out.error(`Error: ${e.message}`));
  else queue = queue.then(run).catch(e => out.error(`Error: ${e.message}`));
}

// Server commands share the prompt's queue and are echoed to the pane, so
// someone watching sees everything an agent does.
function submit(text) {
  return new Promise(resolve => {
    queue = queue.then(async () => {
      if (state.stopping) return resolve({ status: 'error', output: 'The REPL is shutting down.' });
      // Printed above whatever the person at the prompt is typing, which is
      // redrawn afterwards rather than broken up.
      if (process.stdout.isTTY) { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); }
      out.log(`[server] ${text}`);
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
        const output = await out.collect(async () => { result = await execute(text); });
        if (inFlight === flight) inFlight = null;
        if (!flight.answered) resolve({ status: result.status, output, uncertain: result.uncertain });
      }
      if (!state.stopping) prompt(true);
    }).catch(e => { out.error(`Error: ${e.message}`); resolve({ status: 'error', output: e.message }); });
  });
}

function drained() {
  return queue;
}

module.exports = { enqueue, submit, answerInterrupted, drained, busy };
