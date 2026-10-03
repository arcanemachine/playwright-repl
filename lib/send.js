// pw-repl send / where: one command to a running REPL, through its server
// when there is one and through its tmux pane otherwise.
//
// Exit status: 0 ok, 1 command error, 2 completion not confirmed, 64 usage or unreachable.
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const client = require('./client');
const { shellWords, variablesIn } = require('./syntax');

// The prompt, after the modes on in the selected tab if any: (watch network:off) pw[serve]>
const PROMPT = /^(?:\([^()]*\) )?pw(\[serve\])?>\s*$/;

function tmux(...args) {
  return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function hasSession(session) {
  try { tmux('has-session', '-t', session); return true; } catch { return false; }
}

// Which way a command goes: an explicit -e or -s wins, and so does a socket
// named in PW_SOCKET, even one that is gone (a tmux pane is then someone
// else's); otherwise the server when the default socket exists, else tmux.
function route(options) {
  const socket = process.env.PW_SOCKET || client.DEFAULT_SOCKET;
  const endpoint = options.endpoint || process.env.PW_ENDPOINT || '';
  const session = options.session || process.env.PW_TMUX_SESSION || 'playwright-repl';
  if (options.session) return { kind: 'tmux', session };
  if (endpoint) return { kind: 'server', endpoint: client.parseEndpoint(endpoint), explicit: true };
  if (process.env.PW_SOCKET) return { kind: 'server', endpoint: client.parseEndpoint(socket), explicit: true };
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

// A command's words as send was given them, made into the line the REPL reads: quoted again where the
// shell had kept a word whole, and with the files it reads or writes made absolute from the sender's
// folder, since the REPL's may be another.
function commandLine(words) {
  // For a command that reads a quoted selector (fill "text=Your name" Ada), a
  // word the shell kept whole is quoted again so it stays one word. Any other
  // command takes the rest of its line as it is (eval, route's JSON), so its
  // words are joined as they are.
  const { SELECTOR_FIRST } = require('./syntax');
  // So does playwright-cli's storage key (localstorage-set "my key" v).
  // And record's file, which may have spaces in it.
  const requote = words.length > 1 && (SELECTOR_FIRST.has(words[0]) || /^(?:local|session)storage-/.test(words[0]) || words[0] === 'record' || /^video-(?:start|stop)$/.test(words[0]));
  // An empty word (fill #name "") is the empty value.
  // upload's files are read by the REPL, whose folder may not be this one.
  // So are the files upload reads and screenshot --filename writes.
  const resolve = require('path').resolve;
  let resolved = words[0] === 'upload' ? words.map((w, n) => (n > 1 ? resolve(w) : w)) : words;
  // record on <file> writes it too.
  if (words[0] === 'record' || /^video-(?:start|stop)$/.test(words[0])) {
    resolved = words.map((w, n) => {
      if (n < (words[0] === 'record' ? 2 : 1)) return w;
      if (w.startsWith('--filename=') && w.length > 11) return `--filename=${resolve(w.slice(11))}`;
      return words[n - 1] === '--filename' || !/^(?:\d+|-.*)$/.test(w) ? resolve(w) : w;
    });
  }
  // watch save writes its file.
  if (words[0] === 'watch' && words[1] === 'save' && words.length > 2) resolved = ['watch', 'save', resolve(words.slice(2).join(' '))];
  if (words[0] === 'screenshot') {
    resolved = words.map((w, n) => (w.startsWith('--filename=') && w.length > 11 ? `--filename=${resolve(w.slice(11))}` : words[n - 1] === '--filename' ? resolve(w) : w));
  }
  const quoted = requote ? resolved.map(w => (w === '' || /[\s"']/.test(w) ? JSON.stringify(w) : w)) : resolved;
  // An option's value the shell kept whole stays whole too: --device='iPhone 15'.
  // Single quotes escape nothing, so a backslash (a regexp's \d) reaches it as typed.
  for (const [n, w] of quoted.entries()) {
    const option = /^(--[A-Za-z][\w-]*=)([\s\S]*\s[\s\S]*)$/.exec(w);
    if (n && option && !requote) quoted[n] = `${option[1]}${option[2].includes("'") ? JSON.stringify(option[2]) : `'${option[2]}'`}`;
  }
  return quoted.join(' ').trim();
}

// A file of commands, one per line, run in turn until one fails. A recording it started and did not
// stop is still on: the next take would fail to start, so it says so.
const PATHS = /^(?:upload|record|video-start|video-stop|screenshot|watch)$/;
async function sendFile(options) {
  let text;
  try { text = fs.readFileSync(options.file, 'utf8'); } catch (error) { return fail(`cannot read ${options.file} (${error.code || error.message})`); }
  const lines = text.split(/\r?\n/);
  let recording = false;
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    console.log(`> ${line}`);
    // Read as the prompt reads it; a file it reads or writes is the sender's, as on send's command line.
    const words = shellWords(line);
    const command = PATHS.test(words[0]) ? commandLine(words) : line;
    let vars = null;
    if (!options.noVars) {
      const names = variablesIn(command);
      const unset = names.filter(name => process.env[name] === undefined);
      const broken = names.filter(name => /[\r\n]/.test(process.env[name] || ''));
      const stop = why => { console.error(`pw-repl: stopped at line ${i + 1} of ${options.file} (${line}): ${why}`); return 1; };
      if (unset.length) return stop(`${unset.join(', ')} ${unset.length === 1 ? 'is' : 'are'} not set; set ${unset.length === 1 ? 'it' : 'them'} for send (${unset[0]}=... pw-repl send --file ...), or --no-vars sends {{ ${unset[0]} }} as it is`);
      if (broken.length) return stop(`${broken.join(', ')} ${broken.length === 1 ? 'has' : 'have'} a line break, which a line cannot hold`);
      if (names.length) vars = Object.fromEntries(names.map(name => [name, process.env[name]]));
    }
    const status = await send({ ...options, file: null, command, vars });
    if (status !== 0) {
      console.error(`pw-repl: stopped at line ${i + 1} of ${options.file} (${line}), exit status ${status}`);
      if (recording) console.error('pw-repl: record off was not reached, so the recording is still on; pw-repl send record off ends it');
      return status;
    }
    if (/^(?:record\s+on|video-start)\b/.test(line)) recording = true;
    if (/^(?:record\s+off|video-stop)\b/.test(line)) recording = false;
  }
  return 0;
}

async function send(options) {
  if (options.file) return sendFile(options);
  const command = options.command;
  if (!command) return fail('no command given');
  // A newline would reach the REPL as a second, unmarked command.
  if (/[\r\n]/.test(command)) return fail('the command must be a single line');
  const timeoutMs = options.timeout * 1000;
  const way = route(options);
  const name = options.client || process.env.PW_CLIENT || null;
  if (name && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) return fail('a client name is 1-40 letters, digits, dots, dashes and underscores');
  // The pane has one prompt, so a command typed there has no client of its own.
  if (way.kind === 'tmux' && options.client) return fail('-c needs the command server (pw-repl serve); a REPL in tmux has no clients');
  // Typed into the pane, a variable's value would be on screen and in its scrollback.
  if (way.kind === 'tmux' && options.vars) return fail(`{{ ${Object.keys(options.vars)[0]} }} needs the command server (pw-repl serve), which fills it in without showing it; --no-vars sends it as it is`);
  if (way.kind === 'tmux') return viaTmux(way.session, command, timeoutMs);
  const answer = await client.request(way.endpoint, command, timeoutMs, name, options.vars || null);
  if (answer.result?.starting) return fail(`${answer.result.output} (pw-repl where says when it serves)`);
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
  // First, whatever else is reachable: a saved skill is compared with it (pw-repl skill: Start it).
  const skill = require('./skill').current();
  console.log(`skill: ${skill.hash} (pw-repl ${skill.version})`);
  const way = route(options);
  const info = way.kind === 'server' ? await client.healthInfo(way.endpoint, 5000) : null;
  // The browser a running REPL uses (one it launched has its own address); otherwise the one it would
  // use, so a REPL that will not start can be told apart from one that is not running.
  const cdp = info?.browser || process.env.PW_CDP_URL || 'http://localhost:9222';
  const version = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()).catch(() => null);
  // With no REPL running, it is only where one would connect, not a browser of a REPL that stopped.
  const whose = info?.launched ? ', launched by this REPL' : info ? '' : '; run and serve connect here without --launch';
  console.log(version ? `browser: ${cdp} answers (${version.Browser}${whose})` : `browser: nothing answers at ${cdp}; pw-repl run says how to start one`);
  if (way.kind === 'server') {
    const name = client.describe(way.endpoint);
    if (info?.status === 'starting') {
      // Not an error, but not serving yet: exit 64 as for no REPL, so a loop on where waits for it.
      console.log(`server: ${name} (the REPL was started with pw-repl serve and is starting: ${info.step || 'starting'}; retry shortly)`);
      return 64;
    }
    if (info) {
      const background = require('./background').describeBackground(way.endpoint);
      console.log(`server: ${name} (the REPL was started with pw-repl serve${background ? ' --background' : ''})`);
      if (background) console.log(background);
      return 0;
    }
    console.error(way.endpoint.socket && !fs.existsSync(way.endpoint.socket) ? `server: no REPL is serving on ${name} (there is no socket)` : `server: ${name} is not answering`);
    if (way.explicit) return 64;
  }
  const session = options.session || process.env.PW_TMUX_SESSION || 'playwright-repl';
  if (!hasSession(session)) {
    console.error(`tmux: no session '${session}'`);
    console.error('A REPL on a socket of its own is found with -e <socket> or PW_SOCKET.');
    return 64;
  }
  const running = tmux('display-message', '-p', '-t', session, '#{pane_current_command}').trim();
  if (running === 'node') { console.log(`tmux: session '${session}' (the REPL was started with pw-repl run; no server)`); return 0; }
  console.error(`tmux: session '${session}' is running '${running}', not the REPL`);
  console.error('A REPL on a socket of its own is found with -e <socket> or PW_SOCKET.');
  return 64;
}

module.exports = { send, where, commandLine };
