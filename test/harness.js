// Real end to end: a private headless Chromium, a local site, and the REPL
// itself with its server on a temp socket. Nothing is mocked.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// The same search pw-repl run --launch makes, with PW_TEST_CHROME first.
function findChrome() {
  return process.env.PW_TEST_CHROME || require('../lib/launch').findChrome();
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
<label>Color <select id="color"><option>Red</option><option>Blue</option></select></label>
<button id="alerter" onclick="document.querySelector('#out').textContent = 'answered ' + confirm('sure?')">Confirm</button>
<button id="noisy" onclick="console.log('hello-log'); console.error('bad-thing'); setTimeout(() => { throw new Error('boom-uncaught'); })">Noisy</button>`;

// A form to watch and save as commands: two buttons with one text, a secret field a button shows as text,
// a one-time code, an id each component reuses in its shadow root, an option with a long label, an
// element whose place in its shadow root matches one in its host's children too, an app route and a link.
const FLOW_PAGE = `<!doctype html><title>Flow</title>
<div class="row"><span>Trowel</span> <button onclick="add('Trowel')">Add</button></div>
<div class="row"><span>Hose</span> <button onclick="add('Hose')">Add</button></div>
<label>Name <input name="who"></label>
<label>Note <textarea id="note"></textarea></label>
<label>Area <select id="area"><option>Billing</option><option>Shipping</option></select></label>
<label><input type="checkbox" id="gift"> Gift</label>
<label>Password <input type="password" id="pw"></label> <button id="show" onclick="pw.type = pw.type === 'password' ? 'text' : 'password'">Show</button>
<label>Code <input id="otp" autocomplete="one-time-code"></label>
<x-card></x-card><x-card></x-card>
<label>Plan <select id="plan"><option value="basic">Basic</option><option value="pro-yearly">Pro, billed yearly, with priority support and the extended warranty on every order</option></select></label>
<x-pair><div></div><div><i>+</i></div></x-pair>
<button id="route" onclick="history.pushState({}, '', '/flow/routed')">Route</button>
<a id="next" href="/other">Next</a>
<p id="out"></p>
<script>
const items = [];
function add(name) { items.push(name); out.textContent = items.join(','); }
customElements.define('x-card', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<input id="qty">'; } });
customElements.define('x-pair', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<div><i>+</i></div><div><i class="target">+</i></div><slot></slot>'; } });
document.querySelector('[name=who]').addEventListener('keydown', e => { if (e.key === 'Enter') out.textContent += '|entered:' + e.target.value; });
</script>`;

// A single-page app to watch: its routing calls the history API as vue-router does (the current URL
// replaced, then the new one pushed; or pushed, then replaced with more), a date field, and labels
// wrapping a native checkbox and a button that is a checkbox, as Radix draws one.
const APP_PAGE = `<!doctype html><title>App</title>
<input type="date" id="day" aria-label="Day">
<button id="search" onclick="history.replaceState(history.state, '', location.href); history.pushState({}, '', '/app/search')">Search</button>
<button id="filter" onclick="history.pushState({}, '', '/app/search?f=1'); history.replaceState({}, '', '/app/search?f=1&amp;page=1')">Filter</button>
<label><input type="checkbox" id="native"> <span>Native</span></label>
<label><button role="checkbox" aria-checked="false" id="four" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'false')"></button> <span>Four</span> <span>stars</span></label>`;

// Elements a role and a piece of their name find, as watch save writes them: options with ids a framework
// made up, and named from two lines of text (aria-labelledby names nothing); checkboxes named from labels
// with a count in them; links with an image and text, and one piece the other's holds too; a name with
// quotes; a button whose name an input button's value holds too; and an element with a made-up id and no
// name.
const PICKER_PAGE = `<!doctype html><title>Picker</title>
<input role="combobox" placeholder="Where to?" oninput="log('typed')">
<div role="listbox">
  <div role="option" id="radix-vue-combobox-option-v-0-17-4" aria-labelledby="radix-vue-combobox-item-v-0-17-3" onclick="log('cancun')"><div>Cancún</div><div>Quintana Roo, Mexico</div></div>
  <div role="option" id="radix-vue-combobox-option-v-0-17-6" aria-labelledby="radix-vue-combobox-item-v-0-17-5" onclick="log('paradisus')"><div>Paradisus Cancún</div><div>Cancún, Mexico</div></div>
</div>
<label><div><button role="checkbox" onclick="log('4 stars')"></button></div><span>4 Stars</span><span>21</span></label>
<label><div><button role="checkbox" onclick="log('5 stars')"></button></div><span>5 Stars</span><span>4</span></label>
<a href="#one" onclick="log('one')"><img alt="Photo"><span>15% off</span><h3>Hotel Plaza</h3><p>From $171</p></a>
<a href="#two" onclick="log('two')"><img alt="Photo"><h3>Hotel Plaza Caribe</h3></a>
<button onclick="log('quotes')">Don't say "hi"</button>
<button onclick="log('go')">Go</button> <input type="submit" value="Go there" onclick="log('go there')">
<span id="ember1234" tabindex="0" style="display: inline-block; width: 20px; height: 20px" onclick="log('made-up')"></span>
<p id="out"></p>
<script>function log(what) { out.textContent += what + ';'; }</script>`;

// Room cards whose radios repeat their ids, as a page with that bug has them: each label's for= names the
// first card's radio, so a click on another card's label checks the first card's. Two cards share a
// heading, and one label holds a button of its own; and a checkbox with a label of its own beside it.
const CARD = (room, n) => `<section><h3>${room}</h3><div role="radiogroup">
<div><button role="radio" id="radio-BB" aria-label="Bed and Breakfast" aria-checked="false" onclick="pick(this)"></button><label for="radio-BB"><div><div>Bed and Breakfast</div><span>-$60</span></div></label></div>
<div><button role="radio" id="radio-HB" aria-label="Half Board" aria-checked="false" onclick="pick(this)"></button><label for="radio-HB"><div>Half Board</div><button aria-label="More information" onclick="log('info ${n}')">i</button></label></div>
</div></section>`;
const CARDS_PAGE = `<!doctype html><title>Rooms</title>
${CARD('Premium Room', 1)}${CARD('Premium Room', 2)}${CARD('Deluxe Room', 3)}
<input type="checkbox" id="sea" onchange="log('sea ' + this.checked)"> <label for="sea">Sea view</label>
<p id="out"></p>
<script>
function log(what) { out.textContent += what + ';'; }
function pick(radio) {
  const card = [...document.querySelectorAll('section')].indexOf(radio.closest('section')) + 1;
  for (const r of radio.closest('[role=radiogroup]').querySelectorAll('[role=radio]')) r.setAttribute('aria-checked', r === radio);
  log(radio.getAttribute('aria-label') + ' ' + card);
}
</script>`;

async function startSite() {
  const server = http.createServer((req, res) => {
    req.url = new URL(req.url, 'http://fixture').pathname;
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
    if (req.url === '/frame') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Frame</title><iframe srcdoc="<button>inner</button>"></iframe>'); }
    // Several matches: one under an overlay, one hidden, one free; and a pad that logs mouse events.
    if (req.url === '/pick') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><title>Pick</title><body style="margin:0">
<div style="position:fixed;top:0;left:0;width:300px;height:100px;z-index:5;background:#0003"></div>
<button style="position:absolute;top:20px;left:20px" onclick="log.textContent += 'under '">Pick</button>
<button style="visibility:hidden" onclick="log.textContent += 'hidden '">Pick</button>
<button id="free" style="position:absolute;top:150px;left:20px" onclick="log.textContent += 'free '">Pick</button>
<button style="position:absolute;top:40px;left:120px" onclick="log.textContent += 'covered '">Covered</button>
<button style="position:absolute;top:60px;left:200px" onclick="log.textContent += 'covered '">Covered</button>
<button style="position:absolute;top:3000px;left:20px" onclick="log.textContent += 'far-first '">Far</button>
<button style="position:absolute;top:250px;left:20px" onclick="log.textContent += 'far-second '">Far</button>
<div id="again" style="position:absolute;top:250px;left:120px"></div>
<div id="pad" style="position:absolute;top:300px;left:0;width:200px;height:200px;background:#eee"></div>
<p id="log" style="position:absolute;top:520px"></p>
<script>
for (const type of ['mousedown', 'mouseup', 'click']) pad.addEventListener(type, e => { log.textContent += type + ':' + e.button + '@' + e.clientX + ',' + e.clientY + ' '; });
// Rendered again, as a React list is, each time redraw() is called: the element chosen before is replaced.
// On demand, not on a timer: a click must hold still for two frames, which a busy machine could not fit
// between redraws on a timer.
window.redraw = () => { again.innerHTML = '<button style="visibility:hidden">Again</button><button onclick="log.textContent += \\'redrawn \\'">Again</button>'; };
redraw();
pad.addEventListener('wheel', e => { e.preventDefault(); log.textContent += 'wheel:' + e.deltaY + '@' + e.clientX + ',' + e.clientY + ' '; });
</script>`);
    }
    if (req.url === '/cards') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(CARDS_PAGE); }
    if (req.url === '/picker') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PICKER_PAGE); }
    if (req.url === '/app') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(APP_PAGE); }
    if (req.url === '/flow') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(FLOW_PAGE); }
    if (req.url === '/other') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Other</title><h1>Other</h1>'); }
    // Loads for a moment, for wait load.
    if (req.url === '/slow-load') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Slow</title><img src="/slow-image">'); }
    if (req.url === '/slow-image') { setTimeout(() => { res.writeHead(404); res.end(); }, 800); return; }
    if (req.url === '/style.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end('h1 { color: teal; }'); }
    if (req.url === '/api/empty') { res.writeHead(204); return res.end(); }
    if (req.url === '/api/slow') { setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"slow":true}'); }, 1500); return; }
    if (req.url === '/api/data') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"real":true}'); }
    // No content type, as some servers send errors.
    if (req.url === '/untyped-text') { res.writeHead(404); return res.end('not found'); }
    if (req.url === '/untyped-bytes') { res.writeHead(200); return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, stop: () => server.close() };
}

async function startRepl(cdpUrl, env = {}) {
  const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-repl-sock-')), 'repl.sock');
  const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'pw-repl.js'), 'serve', socket], {
    env: { ...process.env, ...env, PW_CDP_URL: cdpUrl },
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
  repl.runAs = (client, command) => repl.request(JSON.stringify({ command, client }));
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
