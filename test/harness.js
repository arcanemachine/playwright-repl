// Real end to end: a private headless Chromium, a local site, and the REPL
// itself with its server on a temp socket. Nothing is mocked.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function findChrome() {
  if (process.env.PW_TEST_CHROME) return process.env.PW_TEST_CHROME;
  try {
    const bundled = require('playwright-core').chromium.executablePath();
    if (fs.existsSync(bundled)) return bundled;
  } catch {}
  // Any Chromium works over CDP, so a different revision than this
  // Playwright expects is fine.
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /^chromium-\d+$/.test(n)).sort().reverse(); } catch {}
  for (const name of names) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const candidate = path.join(dir, name, sub);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const CHROME = findChrome();
const SKIP = CHROME ? false : 'no Chromium found: set PW_TEST_CHROME or run `npx playwright install chromium`';

async function waitFor(check, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-repl-test-'));
  const proc = spawn(CHROME, [
    // /dev/shm is small in containers, and heavier pages crash the tab without this.
    '--headless=new', '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let exit = null;
  proc.on('error', error => { exit = error.message; });
  proc.on('exit', code => { exit = exit || `exit code ${code}`; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const port = await waitFor(() => exit || (fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0]), 'Chromium to start');
  if (exit) {
    fs.rmSync(profile, { recursive: true, force: true });
    throw new Error(`Chromium at ${CHROME} did not start (${exit}); set PW_TEST_CHROME to a working Chromium`);
  }
  return {
    cdpUrl: `http://127.0.0.1:${port}`,
    // Chromium keeps writing to its profile until it has exited.
    async stop() {
      if (exit === null) {
        proc.kill();
        await waitFor(() => exit !== null, 'Chromium to exit').catch(() => proc.kill('SIGKILL'));
      }
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

const PAGE = `<!doctype html><title>Fixture</title>
<link rel="stylesheet" href="/style.css">
<h1>Fixture</h1>
<label>Name <input id="name"></label>
<button id="go" onclick="document.querySelector('#out').textContent = 'Hello ' + document.querySelector('#name').value">Go</button>
<p id="out"></p>
<a href="/other">Other</a>
<div id="composer" contenteditable="true"><p id="typed">my private draft</p></div>
<section aria-label="Results"><div role="alert">Could not load results.</div><button id="upd" disabled>Refresh Results</button></section>
<button id="load" onclick="fetch('/api/data')">Load</button>
<input id="pw" type="password" aria-label="Password">
<span style="position: relative"><button id="under">Under</button><span style="position: absolute; inset: 0"></span></span>
<button id="alerter" onclick="document.querySelector('#out').textContent = 'answered ' + confirm('sure?')">Confirm</button>
<button id="noisy" onclick="console.log('hello-log'); console.error('bad-thing'); setTimeout(() => { throw new Error('boom-uncaught'); })">Noisy</button>`;

async function startSite() {
  const server = http.createServer((req, res) => {
    req.url = new URL(req.url, 'http://fixture').pathname;
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
    if (req.url === '/other') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Other</title><h1>Other</h1>'); }
    if (req.url === '/style.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end('h1 { color: teal; }'); }
    if (req.url === '/api/data') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"real":true}'); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, stop: () => server.close() };
}

async function startRepl(cdpUrl) {
  const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-repl-sock-')), 'repl.sock');
  const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'pw-repl.js'), 'serve', socket], {
    env: { ...process.env, PW_CDP_URL: cdpUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const repl = { socket, proc, stdout: '', exited: false };
  proc.stdout.on('data', d => { repl.stdout += d; });
  proc.stderr.on('data', d => { repl.stdout += d; });
  proc.on('exit', () => { repl.exited = true; });
  await waitFor(() => repl.stdout.includes('Serving commands on') || repl.exited, 'the REPL to start');
  if (repl.exited) throw new Error(`REPL exited during startup:\n${repl.stdout}`);

  repl.request = (body, headers = { 'Content-Type': 'application/json' }) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: '/run', method: 'POST', headers }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ code: res.statusCode, ...JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  repl.run = command => repl.request(JSON.stringify({ command }));
  repl.type = line => proc.stdin.write(`${line}\n`);
  repl.stop = async () => {
    if (!repl.exited) {
      repl.type('quit');
      await waitFor(() => repl.exited, 'the REPL to quit').catch(() => proc.kill());
    }
    fs.rmSync(path.dirname(socket), { recursive: true, force: true });
  };
  return repl;
}

module.exports = { SKIP, waitFor, startChrome, startSite, startRepl };
