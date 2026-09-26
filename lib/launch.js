// pw-repl run|serve --launch: a Chromium of the REPL's own, started for it and
// stopped with it, in a profile that is removed afterwards. It is the quick
// start; a browser set up any other way is reached with PW_CDP_URL instead.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const START_TIMEOUT = 20000;
const STOP_TIMEOUT = 5000;
const INSTALL = 'npx playwright-core install chromium';
const ON_PATH = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'microsoft-edge'];
const MAC_APPS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

// PW_CHROME, then Playwright's own Chromium (wherever PLAYWRIGHT_BROWSERS_PATH
// puts it), then any other revision of it, then a Chromium on the PATH.
function findChrome() {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;
  try {
    const bundled = require('playwright-core').chromium.executablePath();
    if (fs.existsSync(bundled)) return bundled;
  } catch {}
  // Any Chromium works over CDP, so a revision other than this Playwright's is fine.
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /^chromium-\d+$/.test(n)).sort().reverse(); } catch {}
  for (const name of names) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const candidate = path.join(dir, name, sub);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  for (const folder of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of ON_PATH) {
      const candidate = path.join(folder, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
  }
  return MAC_APPS.find(app => fs.existsSync(app)) || null;
}

// Containers often give /dev/shm too little room, and Chromium's tabs then crash.
function smallShm() {
  try { const shm = fs.statfsSync('/dev/shm'); return shm.blocks * shm.bsize < 1024 ** 3; } catch { return false; }
}

// Starts it and waits for the port it picked, which it writes into its profile.
function start(exe, args, profile) {
  return new Promise(resolve => {
    // Its own process group, so stopping it also stops the helper processes it starts.
    const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    let stderr = '';
    let settled = false;
    const done = result => { if (!settled) { settled = true; clearInterval(poll); clearTimeout(timer); resolve(result); } };
    proc.stderr.on('data', d => { if (stderr.length < 20000) stderr += d; });
    proc.on('error', error => done({ error: error.message, stderr }));
    proc.on('exit', code => done({ error: `it exited with code ${code}`, stderr }));
    const portFile = path.join(profile, 'DevToolsActivePort');
    const poll = setInterval(() => {
      try { const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim(); if (port) done({ proc, port }); } catch {}
    }, 100);
    const timer = setTimeout(() => { proc.kill('SIGKILL'); done({ error: `no debugging port within ${START_TIMEOUT / 1000}s`, stderr }); }, START_TIMEOUT);
  });
}

function quoted(args) {
  return args.map(a => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

async function launch({ headed = false, extraArgs = [] }) {
  const exe = findChrome();
  if (!exe) {
    throw new Error(`No Chromium found to launch. Install Playwright's with:\n  ${INSTALL}\nor set PW_CHROME to one, or start one yourself with --remote-debugging-port and set PW_CDP_URL.`);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-repl-chrome-'));
  const ours = [...(headed ? [] : ['--headless=new']), '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', ...(smallShm() ? ['--disable-dev-shm-usage'] : [])];
  // Flags given after -- come after these, so they can override them.
  let args = [...ours, ...extraArgs, 'about:blank'];
  let result = await start(exe, args, profile);
  let note = null;
  // Tried with the sandbox first; a container often cannot give Chromium one.
  if (result.error && /sandbox/i.test(result.stderr)) {
    args = [...ours, '--no-sandbox', ...extraArgs, 'about:blank'];
    result = await start(exe, args, profile);
    note = 'Chromium could not use its sandbox here, so it runs with --no-sandbox.';
  }
  const command = quoted([exe, ...args]);
  if (result.error) {
    fs.rmSync(profile, { recursive: true, force: true });
    const last = result.stderr.trim().split('\n').slice(-5).join('\n');
    throw new Error(`Chromium did not start (${result.error}):\n  ${command}${last ? `\n${last}` : ''}`);
  }
  const { proc, port } = result;
  const signal = name => { try { process.kill(-proc.pid, name); } catch {} };
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      signal('SIGTERM');
      await new Promise(resolve => { const t = setTimeout(() => { signal('SIGKILL'); resolve(); }, STOP_TIMEOUT); proc.once('exit', () => { clearTimeout(t); resolve(); }); });
    }
    // Its helper processes can still be writing to the profile for a moment.
    for (let tries = 0; tries < 30; tries++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  };
  // If the REPL goes without shutting down, the browser still goes with it.
  process.on('exit', () => signal('SIGKILL'));
  return { url: `http://127.0.0.1:${port}`, command, note, headed, stop };
}

module.exports = { findChrome, launch, INSTALL };
