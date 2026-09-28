// pw-repl run|serve --launch: a Chromium of the REPL's own, started for it and
// stopped with it, in a profile that is removed afterwards. It is the quick
// start; a browser set up any other way is reached with PW_CDP_URL instead.
// A --user-data-dir among the flags after -- is used instead, and kept.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const START_TIMEOUT = 20000;
// Stopping: a moment to connect and ask it to close, a few seconds to close, as long again after SIGTERM,
// and up to 3s to remove a profile its helpers are still writing to. STOP_WORST is what it can take.
const CLOSE_CONNECT_TIMEOUT = 2000;
const CLOSE_TIMEOUT = 3000;
const TERM_TIMEOUT = 3000;
const STOP_WORST = CLOSE_CONNECT_TIMEOUT + CLOSE_TIMEOUT + TERM_TIMEOUT + 3000;
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

const GROUP_GONE_TIMEOUT = 2000;

// A launched Chromium runs in its own process group, so this stops the helper processes it starts too.
function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch {}
}

async function groupGone(pid) {
  const deadline = Date.now() + GROUP_GONE_TIMEOUT;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// Starts it and waits for the port it picked, which it prints (as Playwright reads it too): a
// DevToolsActivePort file in a profile of the caller's can be one an earlier run left behind.
// One that does not start is stopped, helpers and all, before this returns.
function start(exe, args, onSpawn) {
  return new Promise(resolve => {
    const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    onSpawn(proc);
    let stderr = '';
    let partial = '';
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (!result.error) return resolve(result);
      killGroup(proc.pid);
      // A helper still holding the profile's lock would make a retry in the same profile fail.
      groupGone(proc.pid).then(() => resolve(result));
    };
    proc.stderr.on('data', d => {
      if (stderr.length < 20000) stderr += d;
      const text = partial + d;
      const listening = /^DevTools listening on ws:\/\/[^/\s]+:(\d+)\//m.exec(text);
      if (listening) done({ proc, port: listening[1] });
      partial = text.slice(text.lastIndexOf('\n') + 1);
    });
    proc.on('error', error => done({ error: error.message, stderr }));
    proc.on('exit', code => done({ error: `it exited with code ${code}`, stderr }));
    const timer = setTimeout(() => done({ error: `no debugging port within ${START_TIMEOUT / 1000}s`, stderr }), START_TIMEOUT);
  });
}

// Chromium takes only --user-data-dir=<dir>, and the last one given.
function userDataDir(args) {
  const given = args.filter(a => a.startsWith('--user-data-dir=')).pop();
  return given ? path.resolve(given.slice('--user-data-dir='.length)) : null;
}

async function closeBrowser(url) {
  let browser;
  try {
    browser = await require('playwright-core').chromium.connectOverCDP(url, { timeout: CLOSE_CONNECT_TIMEOUT });
    const session = await browser.newBrowserCDPSession();
    // It closes before it answers, or as it does.
    await session.send('Browser.close').catch(() => {});
  } catch {}
  try { await browser?.close(); } catch {}
}

function quoted(args) {
  return args.map(a => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

async function launch({ headed = false, extraArgs = [] }) {
  const exe = findChrome();
  if (!exe) {
    throw new Error(`No Chromium found to launch. Install Playwright's with:\n  ${INSTALL}\nor set PW_CHROME to one, or start one yourself with --remote-debugging-port and set PW_CDP_URL.`);
  }
  const given = userDataDir(extraArgs);
  const profile = given || fs.mkdtempSync(path.join(os.tmpdir(), 'pw-repl-chrome-'));
  const removeProfile = () => { if (!given) fs.rmSync(profile, { recursive: true, force: true }); };
  // Registered before Chromium starts, and kept for the REPL's life: a REPL that goes without shutting
  // down, even while it waits for Chromium, still takes it (and a profile of its own) along.
  let group = null;
  const onExit = () => { if (group) killGroup(group); try { removeProfile(); } catch {} };
  process.on('exit', onExit);
  const onSpawn = proc => { group = proc.pid; };
  const ours = [...(headed ? [] : ['--headless=new']), '--remote-debugging-port=0', ...(given ? [] : [`--user-data-dir=${profile}`]),
    '--no-first-run', '--no-default-browser-check', ...(smallShm() ? ['--disable-dev-shm-usage'] : [])];
  // A profile already used has tabs to restore; a blank tab of its own each time would pile up there.
  // Local State is written at its root on the first run, whichever --profile-directory is used.
  const blank = given && fs.existsSync(path.join(given, 'Local State')) ? [] : ['about:blank'];
  // Flags given after -- come after these, so they can override them.
  let args = [...ours, ...extraArgs, ...blank];
  let result = await start(exe, args, onSpawn);
  let note = null;
  // Tried with the sandbox first; a container often cannot give Chromium one.
  if (result.error && /sandbox/i.test(result.stderr)) {
    args = [...ours, '--no-sandbox', ...extraArgs, ...blank];
    result = await start(exe, args, onSpawn);
    note = 'Chromium could not use its sandbox here, so it runs with --no-sandbox.';
  }
  const command = quoted([exe, ...args]);
  if (result.error) {
    process.removeListener('exit', onExit);
    removeProfile();
    const last = result.stderr.trim().split('\n').slice(-5).join('\n');
    throw new Error(`Chromium did not start (${result.error}):\n  ${command}${last ? `\n${last}` : ''}`);
  }
  const { proc, port } = result;
  const url = `http://127.0.0.1:${port}`;
  const exited = new Promise(resolve => { if (proc.exitCode !== null || proc.signalCode !== null) resolve(); else proc.once('exit', resolve); });
  const exitsWithin = ms => Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(resolve, ms, false))]);
  const stop = async () => {
    if (!(await exitsWithin(0))) {
      // Browser.close shuts it down in order: its helpers save the profile (what pages last wrote to
      // localStorage) and it removes the profile's lock. SIGTERM to the browser process saves the
      // profile too but leaves the lock; to the whole group, it loses the last writes.
      // Not awaited: a browser that hangs may never answer; its exit is what counts.
      void closeBrowser(url);
      if (!(await exitsWithin(CLOSE_CONNECT_TIMEOUT + CLOSE_TIMEOUT))) {
        try { process.kill(proc.pid, 'SIGTERM'); } catch {}
        await exitsWithin(TERM_TIMEOUT);
      }
    }
    killGroup(proc.pid);
    // Its helper processes can still be writing to the profile for a moment.
    for (let tries = 0; tries < 30; tries++) {
      try { removeProfile(); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  };
  return { url, command, note, headed, stop };
}

module.exports = { findChrome, launch, INSTALL, START_TIMEOUT, STOP_WORST };
