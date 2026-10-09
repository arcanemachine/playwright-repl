// pw-repl serve --background, attach and stop: a REPL that runs detached,
// found through the files it keeps next to its socket.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const client = require('./client');
const { STOPPED_RECORDING, ENDED_UNSEEN } = require('./util');

const BIN = path.join(__dirname, '..', 'bin', 'pw-repl.js');
const START_TIMEOUT = 20000;
// Longer than --launch gives Chromium, twice when it retries without the sandbox, then the connect: its own
// error, and its cleanup, come first.
const LAUNCH_START_TIMEOUT = 2 * require('./launch').START_TIMEOUT + 20000;
// Longer than a REPL can take to stop: its cleanups and letting go of the browser (up to
// SHUTDOWN_TIMEOUT each), then stopping a Chromium it launched.
const STOP_TIMEOUT = 2 * require('./state').SHUTDOWN_TIMEOUT + require('./launch').STOP_WORST + 4000;
const LOG_LIMIT = 5 * 1024 * 1024;
const FOLLOW_INTERVAL = 150;
const ATTACH_BACKLOG = 20;
const ATTACH_COMMAND_TIMEOUT = 3600000;

// /tmp/pw-repl.sock keeps /tmp/pw-repl.pid and .log; a port, /tmp/pw-repl-<port>.*.
function filesFor(endpoint) {
  const base = endpoint.socket ? endpoint.socket.replace(/\.sock$/, '') : path.join('/tmp', `pw-repl-${endpoint.port}`);
  return { pidFile: `${base}.pid`, logFile: `${base}.log` };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// The pid of the background REPL, or null; a pid file left by one that died is removed.
function runningPid(pidFile) {
  let pid;
  try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch { return null; }
  if (pid > 0 && alive(pid)) return pid;
  try { fs.unlinkSync(pidFile); } catch {}
  return null;
}

// What attach and stop need to find a REPL that is not on the default socket.
function endpointFlag(endpointArg) {
  const endpoint = client.parseEndpoint(endpointArg);
  return endpoint.socket === client.DEFAULT_SOCKET ? '' : ` -e ${client.describe(endpoint)}`;
}

function fail(message) {
  console.error(`pw-repl: ${message}`);
  return 64;
}

function tail(file, lines) {
  try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

// Called in the background REPL as it starts: however it ends, served or not, its log says so.
function markStopInLog() {
  process.on('exit', code => {
    try { fs.writeSync(process.stdout.fd, `--- ${new Date().toISOString()} stopped${code ? ` (exit code ${code})` : ''}\n`); } catch {}
  });
}

// Called in the background REPL once it serves: its pid file says it runs, and goes when it exits.
function claimPidFile(pidFile) {
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  process.on('exit', () => {
    try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile); } catch {}
  });
}

// Why a REPL cannot serve on an endpoint another one serves on, and what to do instead; null if none does.
async function alreadyServing(endpoint) {
  const name = client.describe(endpoint);
  const another = `; to start another, give it a socket of its own: -e /tmp/<name>.sock`;
  const background = runningPid(filesFor(endpoint).pidFile);
  if (background) return `a background REPL is already serving on ${name} (pid ${background}): pw-repl attach uses it, pw-repl stop stops it${another}`;
  const info = await client.healthInfo(endpoint, 2000);
  if (!info) return null;
  return `a REPL is already serving on ${name}${info.pid ? ` (pid ${info.pid})` : ''}, in a terminal: pw-repl send uses it, and quit at its prompt stops it${another}`;
}

async function start(options) {
  const endpoint = client.parseEndpoint(options.endpoint);
  const name = client.describe(endpoint);
  const { pidFile, logFile } = filesFor(endpoint);
  const serving = await alreadyServing(endpoint);
  if (serving) return fail(serving);
  // Appended to, so an earlier run's log stays; each run is marked where it starts and stops. One grown
  // past LOG_LIMIT is moved to <log>.1 first, replacing the one there.
  try { if (fs.statSync(logFile).size > LOG_LIMIT) fs.renameSync(logFile, `${logFile}.1`); } catch {}
  const log = fs.openSync(logFile, 'a', 0o600);
  fs.fchmodSync(log, 0o600);
  fs.writeSync(log, `--- ${new Date().toISOString()} started\n`);
  const args = [BIN, 'serve', ...(options.launch ? ['--launch'] : []), ...(options.headed ? ['--headed'] : []),
    ...(options.endpoint ? [options.endpoint] : []), ...(options.startUrl ? [options.startUrl] : []),
    ...(options.chromeArgs.length ? ['--', ...options.chromeArgs] : [])];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, PW_REPL_PID_FILE: pidFile },
  });
  fs.closeSync(log);
  let exited = false;
  const gone = new Promise(resolve => child.on('exit', () => { exited = true; resolve(); }));
  // Ctrl-C while it waits gives up on the start: the REPL is stopped (and a Chromium it launched with it),
  // rather than left starting where stop cannot reach it yet.
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, interrupt);
  const deadline = Date.now() + (options.launch ? LAUNCH_START_TIMEOUT : START_TIMEOUT);
  while (!exited && !interrupted && Date.now() < deadline && !(await client.ready(endpoint, 1000) && runningPid(pidFile))) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  for (const signal of signals) process.removeListener(signal, interrupt);
  if (interrupted) {
    if (!exited) child.kill();
    await Promise.race([gone, new Promise(resolve => setTimeout(resolve, STOP_TIMEOUT))]);
    try { fs.appendFileSync(logFile, `--- ${new Date().toISOString()} the start was interrupted\n`); } catch {}
    console.error(`pw-repl: ${exited ? 'interrupted; the background REPL was stopped before it served' : `interrupted; the background REPL (pid ${child.pid}) has not stopped after ${STOP_TIMEOUT / 1000}s`}`);
    // As a shell reports a command stopped by Ctrl-C.
    return 130;
  }
  if (exited || !runningPid(pidFile)) {
    if (!exited) child.kill();
    const last = tail(logFile, 12);
    return fail(`the background REPL did not start${last ? `; the end of ${logFile}:\n${last}` : ''}`);
  }
  child.unref();
  const e = endpointFlag(options.endpoint);
  console.log(`Serving in the background (pid ${child.pid}) on ${name}`);
  console.log(`Log: ${logFile}`);
  console.log('');
  const attachCommand = `pw-repl attach${e}`;
  console.log(`  ${attachCommand}  see everything it does, and type commands to it`);
  console.log(`  ${`pw-repl stop${e}`.padEnd(attachCommand.length)}  stop it`);
  return 0;
}

async function stop(options) {
  const endpoint = client.parseEndpoint(options.endpoint);
  const { pidFile } = filesFor(endpoint);
  const pid = runningPid(pidFile);
  if (!pid) return fail(`no background REPL is serving on ${client.describe(endpoint)}`);
  // What it logs as it stops, from here on, holds what became of each recording it ended.
  const { logFile } = filesFor(endpoint);
  let logFrom = 0;
  try { logFrom = fs.statSync(logFile).size; } catch {}
  // Like Ctrl-C: a command still running is answered, and the socket is removed.
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + STOP_TIMEOUT;
  while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (alive(pid)) return fail(`the background REPL (pid ${pid}) has not stopped after ${STOP_TIMEOUT / 1000}s`);
  console.log(`Stopped the background REPL (pid ${pid}) on ${client.describe(endpoint)}; its log stays at ${logFile}`);
  // The REPL is gone, so record can no longer say where a recording it ended went, or that it was lost.
  let logged = '';
  try {
    const fd = fs.openSync(logFile, 'r');
    const buffer = Buffer.alloc(Math.max(0, fs.fstatSync(fd).size - logFrom));
    fs.readSync(fd, buffer, 0, buffer.length, logFrom);
    fs.closeSync(fd);
    logged = buffer.toString('utf8');
  } catch {}
  for (const line of logged.split('\n')) if (line.startsWith(STOPPED_RECORDING) || line.startsWith(ENDED_UNSEEN)) console.log(line);
  return 0;
}

// Follows the background REPL's log, which holds everything it prints, and
// sends what is typed as commands; their output then shows in the log too.
async function attach(options) {
  const endpoint = client.parseEndpoint(options.endpoint);
  const name = client.describe(endpoint);
  const { pidFile, logFile } = filesFor(endpoint);
  const pid = runningPid(pidFile);
  if (!pid) {
    const info = await client.healthInfo(endpoint, 2000);
    if (info?.status === 'starting') return fail(`the REPL on ${name} is starting; retry shortly`);
    return fail(info ? `the REPL on ${name} runs in a terminal, not in the background; use it there` : `no background REPL is serving on ${name}; pw-repl serve --background starts one`);
  }
  const fd = fs.openSync(logFile, 'r');
  const backlog = tail(logFile, ATTACH_BACKLOG);
  let position = fs.fstatSync(fd).size;
  console.log(`Attached to the background REPL (pid ${pid}) on ${name}. Ctrl-C or Ctrl-D leaves it running.`);
  if (backlog) console.log(`\n${backlog}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'pw[attach]> ' });
  let inputEnded = false;
  // New log lines go above what is being typed, which is then redrawn.
  const follow = () => {
    const size = fs.fstatSync(fd).size;
    if (size < position) position = 0;
    if (size === position) return;
    const buffer = Buffer.alloc(size - position);
    fs.readSync(fd, buffer, 0, buffer.length, position);
    position = size;
    if (process.stdout.isTTY) { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); }
    process.stdout.write(buffer.toString('utf8'));
    if (!inputEnded) rl.prompt(true);
  };
  let leaving = false;
  const leave = message => {
    if (leaving) return;
    leaving = true;
    clearInterval(timer);
    follow();
    process.stdout.write(`\n${message}\n`);
    process.exit(0);
  };
  const timer = setInterval(() => {
    follow();
    if (!runningPid(pidFile)) leave('The background REPL stopped.');
  }, FOLLOW_INTERVAL);
  let queue = Promise.resolve();
  rl.on('line', line => {
    const command = line.trim();
    if (!command) { if (!inputEnded) rl.prompt(); return; }
    if (command === 'quit' || command === 'exit') { leave('Left; the background REPL keeps running (pw-repl stop stops it).'); return; }
    queue = queue.then(async () => {
      const answer = await client.request(endpoint, command, ATTACH_COMMAND_TIMEOUT);
      if (answer.unreachable || answer.dropped) console.error(`pw-repl: the background REPL did not answer (${answer.unreachable || answer.dropped})`);
      // Let the log catch up, so the prompt comes back after the output.
      await new Promise(resolve => setTimeout(resolve, FOLLOW_INTERVAL));
      follow();
    });
  });
  // Input can end before the commands typed ahead of it have run (e.g. piped in).
  rl.on('close', () => {
    inputEnded = true;
    queue.then(() => leave('Left; the background REPL keeps running (pw-repl stop stops it).'));
  });
  rl.on('SIGINT', () => leave('Left; the background REPL keeps running (pw-repl stop stops it).'));
  rl.prompt();
  return new Promise(() => {});
}

// For pw-repl where: the background REPL on an endpoint, if there is one.
function describeBackground(endpoint) {
  const { pidFile, logFile } = filesFor(endpoint);
  const pid = runningPid(pidFile);
  if (!pid) return null;
  let since = '';
  try { since = `, since ${fs.statSync(pidFile).mtime.toLocaleString()}`; } catch {}
  const e = endpoint.socket === client.DEFAULT_SOCKET ? '' : ` -e ${client.describe(endpoint)}`;
  return `background: pid ${pid}${since}; log ${logFile} (pw-repl attach${e}, pw-repl stop${e})`;
}

module.exports = { alreadyServing, filesFor, endpointFlag, markStopInLog, claimPidFile, start, stop, attach, describeBackground };
