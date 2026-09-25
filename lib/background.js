// pw-repl serve --background, attach and stop: a REPL that runs detached,
// found through the files it keeps next to its socket.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const client = require('./client');

const BIN = path.join(__dirname, '..', 'bin', 'pw-repl.js');
const START_TIMEOUT = 20000;
const STOP_TIMEOUT = 10000;
const FOLLOW_INTERVAL = 150;
const ATTACH_BACKLOG = 20;
const ATTACH_COMMAND_TIMEOUT = 3600000;

// /tmp/playwright-repl.sock keeps /tmp/playwright-repl.pid and .log; a port, /tmp/playwright-repl-<port>.*.
function filesFor(endpoint) {
  const base = endpoint.socket ? endpoint.socket.replace(/\.sock$/, '') : path.join('/tmp', `playwright-repl-${endpoint.port}`);
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

function fail(message) {
  console.error(`pw-repl: ${message}`);
  return 64;
}

function tail(file, lines) {
  try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

// Called in the background REPL once it serves: its pid file says it runs, and goes when it exits.
function claimPidFile(pidFile) {
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  process.on('exit', () => {
    try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile); } catch {}
  });
}

async function start(options) {
  const endpoint = client.parseEndpoint(options.endpoint);
  const name = client.describe(endpoint);
  const { pidFile, logFile } = filesFor(endpoint);
  const running = runningPid(pidFile);
  if (running) return fail(`a background REPL is already serving on ${name} (pid ${running}); pw-repl attach uses it, pw-repl stop stops it`);
  if (await client.health(endpoint, 2000)) return fail(`a REPL is already serving on ${name}, in a terminal; pw-repl where says more`);
  const log = fs.openSync(logFile, 'w', 0o600);
  fs.fchmodSync(log, 0o600);
  const args = [BIN, 'serve', ...(options.endpoint ? [options.endpoint] : []), ...(options.startUrl ? [options.startUrl] : [])];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, PW_REPL_PID_FILE: pidFile },
  });
  fs.closeSync(log);
  let exited = false;
  child.on('exit', () => { exited = true; });
  const deadline = Date.now() + START_TIMEOUT;
  while (!exited && Date.now() < deadline && !(await client.health(endpoint, 1000) && runningPid(pidFile))) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (exited || !runningPid(pidFile)) {
    if (!exited) child.kill();
    const last = tail(logFile, 10);
    return fail(`the background REPL did not start${last ? `; the end of ${logFile}:\n${last}` : ''}`);
  }
  child.unref();
  console.log(`Serving in the background (pid ${child.pid}) on ${name}`);
  console.log(`Log: ${logFile}`);
  console.log('');
  console.log('  pw-repl attach  see everything it does, and type commands to it');
  console.log('  pw-repl stop    stop it');
  return 0;
}

async function stop(options) {
  const endpoint = client.parseEndpoint(options.endpoint);
  const { pidFile } = filesFor(endpoint);
  const pid = runningPid(pidFile);
  if (!pid) return fail(`no background REPL is serving on ${client.describe(endpoint)}`);
  // Like Ctrl-C: a command still running is answered, and the socket is removed.
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + STOP_TIMEOUT;
  while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (alive(pid)) return fail(`the background REPL (pid ${pid}) has not stopped after ${STOP_TIMEOUT / 1000}s`);
  console.log(`Stopped the background REPL (pid ${pid})`);
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
    const served = await client.health(endpoint, 2000);
    return fail(served ? `the REPL on ${name} runs in a terminal, not in the background; use it there` : `no background REPL is serving on ${name}; pw-repl serve --background starts one`);
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
  return `background: pid ${pid}${since}; log ${logFile} (pw-repl attach, pw-repl stop)`;
}

module.exports = { filesFor, claimPidFile, start, stop, attach, describeBackground };
