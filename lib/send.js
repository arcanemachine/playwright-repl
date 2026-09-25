// pw-repl send / where: one command to a running REPL, through its server
// when there is one and through its tmux pane otherwise.
//
// Exit status: 0 ok, 1 command error, 2 completion not confirmed, 64 usage or unreachable.
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const client = require('./client');

// The prompt, after the modes on in the selected tab if any: (watch network:off) pw[serve]>
const PROMPT = /^(?:\([^()]*\) )?pw(\[serve\])?>\s*$/;

function tmux(...args) {
  return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function hasSession(session) {
  try { tmux('has-session', '-t', session); return true; } catch { return false; }
}

// Which way a command goes: an explicit -e or -s wins; otherwise the server
// when its socket exists, else tmux.
function route(options) {
  const socket = process.env.PW_SOCKET || client.DEFAULT_SOCKET;
  const endpoint = options.endpoint || process.env.PW_ENDPOINT || '';
  const session = options.session || process.env.PW_TMUX_SESSION || 'playwright-repl';
  if (options.session) return { kind: 'tmux', session };
  if (endpoint) return { kind: 'server', endpoint: client.parseEndpoint(endpoint), explicit: true };
  if (fs.existsSync(socket) && fs.statSync(socket).isSocket()) return { kind: 'server', endpoint: client.parseEndpoint(socket), explicit: false, socket };
  return { kind: 'tmux', session };
}

function fail(message) {
  console.error(`pw-repl: ${message}`);
  return 64;
}

// Checks a pane is running the REPL and sitting at a bare prompt. A REPL that
// is exiting is still node for a moment but never shows a fresh prompt again,
// and its last messages print on the prompt line ("pw> Browser command outcome
// is unknown; ..."), so only a bare prompt counts. That also refuses while a
// command runs or someone is typing.
function paneProblem(session) {
  if (!hasSession(session)) return `no tmux session '${session}' and no REPL server; pw-repl serve --background starts one (pw-repl skill: Start it)`;
  const running = tmux('display-message', '-p', '-t', session, '#{pane_current_command}').trim();
  if (running !== 'node') return `the REPL is not running in '${session}' (pane is running '${running}'); start it there with pw-repl run (pw-repl skill: Start it)`;
  const lines = tmux('capture-pane', '-t', session, '-p').split('\n').filter(line => line.trim());
  if (!PROMPT.test(lines[lines.length - 1] || '')) {
    return `the REPL in '${session}' is not at a bare pw> or pw[serve]> prompt (busy, being typed at, or exiting); retry once it is, or check with pw-repl where`;
  }
  return null;
}

async function viaTmux(session, command, timeoutMs) {
  const problem = paneProblem(session);
  if (problem) return fail(problem);
  // Random, so a marker left in the scrollback by an earlier command never matches.
  const id = crypto.randomBytes(4).toString('hex');
  tmux('send-keys', '-t', session, '-l', `@${id} ${command}`);
  tmux('send-keys', '-t', session, 'Enter');
  // -J joins lines tmux wrapped at the pane width, so long URLs stay whole.
  const capture = () => tmux('capture-pane', '-t', session, '-p', '-J', '-S', '-10000');
  const marker = new RegExp(`\\[\\[pw-done:${id}:(ok|error)\\]\\]`);
  const deadline = Date.now() + timeoutMs;
  let status = null;
  let screen = '';
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    screen = capture();
    const match = marker.exec(screen);
    if (match) { status = match[1]; break; }
  }
  // Everything after the echoed input line; up to the marker when there is one.
  const lines = screen.split('\n');
  const start = lines.findIndex(line => line.includes(`@${id} `));
  const output = [];
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    if (line.includes(`[[pw-done:${id}:`)) break;
    output.push(line);
  }
  if (output.length) console.log(output.join('\n'));
  if (status === 'ok') return 0;
  if (status === 'error') return 1;
  console.error('completion not confirmed');
  return 2;
}

async function send(options) {
  const command = options.command;
  if (!command) return fail('no command given');
  // A newline would reach the REPL as a second, unmarked command.
  if (/[\r\n]/.test(command)) return fail('the command must be a single line');
  const timeoutMs = options.timeout * 1000;
  const way = route(options);
  if (way.kind === 'tmux') return viaTmux(way.session, command, timeoutMs);
  const answer = await client.request(way.endpoint, command, timeoutMs);
  if (answer.result) {
    if (answer.result.output) console.log(answer.result.output);
    if (answer.result.unconfirmed) { console.error('completion not confirmed'); return 2; }
    return answer.result.status === 'ok' ? 0 : 1;
  }
  if (answer.timeout) { console.error('completion not confirmed'); return 2; }
  if (answer.dropped) { console.error(`completion not confirmed: the REPL closed the connection (${answer.dropped})`); return 2; }
  if (way.explicit) return fail(answer.unreachable === 'ENOENT' ? `no REPL is serving on ${client.describe(way.endpoint)} (there is no socket)` : `cannot reach the REPL server at ${client.describe(way.endpoint)} (${answer.unreachable})`);
  // The server was expected, so the REPL has most likely just exited or is
  // exiting. Falling back to tmux now could type into the shell it leaves behind.
  return fail(`the REPL server at ${way.socket} is not answering (${answer.unreachable}); not falling back to tmux. Check with pw-repl where; if the REPL now runs without the server, use -s or remove ${way.socket}`);
}

// Reports the route a command would take, checking it the way a command would.
async function where(options) {
  const way = route(options);
  if (way.kind === 'server') {
    const name = client.describe(way.endpoint);
    if (await client.health(way.endpoint, 5000)) {
      const background = require('./background').describeBackground(way.endpoint);
      console.log(`server: ${name} (the REPL was started with pw-repl serve${background ? ' --background' : ''})`);
      if (background) console.log(background);
      return 0;
    }
    console.error(way.endpoint.socket && !fs.existsSync(way.endpoint.socket) ? `server: no REPL is serving on ${name} (there is no socket)` : `server: ${name} is not answering`);
    if (way.explicit) return 64;
  }
  const session = options.session || process.env.PW_TMUX_SESSION || 'playwright-repl';
  if (!hasSession(session)) { console.error(`tmux: no session '${session}'`); return 64; }
  const running = tmux('display-message', '-p', '-t', session, '#{pane_current_command}').trim();
  if (running === 'node') { console.log(`tmux: session '${session}' (the REPL was started with pw-repl run; no server)`); return 0; }
  console.error(`tmux: session '${session}' is running '${running}', not the REPL`);
  return 64;
}

module.exports = { send, where };
