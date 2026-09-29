// REPLs that each need a Chromium of their own: they quit, time out or are killed. A file of their
// own, so they run alongside repl.test.js's long run on one shared browser.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { SKIP, waitFor, startChrome, startSite, startRepl } = require('./harness');

describe('quitting a REPL that changed a tab', { skip: SKIP }, () => {
  let chrome, site;

  before(async () => {
    chrome = await startChrome();
    site = await startSite();
  });

  after(async () => {
    site?.stop();
    await chrome?.stop();
  });

  it('leaves the tab as it was: no emulation, and the network at full speed', async () => {
    const timed = 'eval (async () => { const t = performance.now(); await fetch("/api/data?" + Math.random()); return Math.round(performance.now() - t); })()';
    const state = 'eval JSON.stringify([matchMedia("(prefers-color-scheme: dark)").matches, innerWidth, navigator.userAgent.includes("Mobile")])';
    const first = await startRepl(chrome.cdpUrl);
    let before;
    try {
      assert.equal((await first.run(`tab new ${site.url}/?quit`)).status, 'ok');
      before = (await first.run(state)).output;
      for (const command of ['emulate mobile', 'emulate dark', 'network slow 700']) {
        const result = await first.run(command);
        assert.equal(result.status, 'ok', `${command}\n${result.output}`);
      }
      assert.notEqual((await first.run(state)).output, before, 'emulated');
      assert.ok(Number((await first.run(timed)).output) >= 650, 'slowed');
    } finally {
      await first.stop();
    }
    const second = await startRepl(chrome.cdpUrl);
    try {
      assert.equal((await second.run('tab quit')).status, 'ok');
      assert.equal((await second.run(state)).output, before, 'the emulation was reset on quit');
      assert.ok(Number((await second.run(timed)).output) < 500, 'the network is back to full speed');
    } finally {
      await second.stop();
    }
  });
});

describe('a command that times out', { skip: SKIP }, () => {
  let chrome, site, repl;

  before(async () => {
    chrome = await startChrome();
    site = await startSite();
    repl = await startRepl(chrome.cdpUrl);
    await repl.run(`tab new ${site.url}/`);
  });

  after(async () => {
    await repl?.stop();
    site?.stop();
    await chrome?.stop();
  });

  it('reports an element that never appeared as an ordinary error, and carries on', async () => {
    const result = await repl.run('click #not-on-the-page');
    assert.equal(result.status, 'error');
    assert.equal(result.unconfirmed, undefined, 'nothing was clicked');
    assert.match(result.output, /^Error: No element matches #not-on-the-page \(waited 5s\)$/m);
    assert.doesNotMatch(result.output, /Outcome unknown/);
    assert.equal((await repl.run('info')).status, 'ok');
  });

  it('reports a click that timed out after finding its element as unconfirmed, in a line, and carries on', async () => {
    // Through send, for its exit status too.
    const { spawn } = require('child_process');
    const sent = await new Promise(resolve => {
      const child = spawn(process.execPath, [require('path').join(__dirname, '..', 'bin', 'pw-repl.js'), 'send', '-e', repl.socket, 'click', '#under'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', status => resolve({ status, stdout, stderr }));
    });
    assert.equal(sent.status, 2, 'completion not confirmed');
    assert.match(sent.stderr, /completion not confirmed/);
    assert.doesNotMatch(sent.stdout, /snapshot ref/);
    assert.match(sent.stdout, /^Error: Timed out after 5s on #under: <span.*> intercepts pointer events \(its call log is in the REPL's pane or log\)\nOutcome unknown: it timed out after it began acting on the page/);
    assert.doesNotMatch(sent.stdout, /Call log/);
    assert.match(repl.stdout, /Playwright's call log:[\s\S]*attempting click action/, 'the whole log is in the pane');
    assert.equal(repl.exited, false);
    assert.equal((await repl.run('info')).status, 'ok');
  });
});

describe('watch on --changes on a page too busy to snapshot', { skip: SKIP }, () => {
  let chrome, site, repl;

  before(async () => {
    chrome = await startChrome();
    site = await startSite();
    repl = await startRepl(chrome.cdpUrl);
    await repl.run(`tab new ${site.url}/`);
  });

  after(async () => {
    await repl?.stop();
    site?.stop();
    await chrome?.stop();
  });

  it('starts watching anyway instead of disconnecting', async () => {
    // Keeps the page busy for 4s right after watch on sets up, so the first snapshot times out.
    await repl.run('eval Object.defineProperty(window, "__pwReplWatching", { get: () => false, set() { setTimeout(() => { const t = Date.now(); while (Date.now() - t < 4000); }); } })');
    const result = await repl.run('watch on --changes');
    assert.equal(result.status, 'ok', result.output);
    assert.match(result.output, /Could not snapshot the page yet/);
    assert.equal(repl.exited, false);
    assert.equal((await repl.run('info')).status, 'ok');
  });
});

describe('quitting at the prompt while a sent command runs', { skip: SKIP }, () => {
  const { spawn } = require('child_process');
  const path = require('path');
  let chrome, site, repl;

  before(async () => {
    chrome = await startChrome();
    site = await startSite();
  });

  after(async () => {
    await repl?.stop();
    site?.stop();
    await chrome?.stop();
  });

  // Sends through pw-repl send, as an agent would, and stops the REPL once the command is running.
  const sendThenQuit = async (command, stop = () => repl.type('quit')) => {
    // Each test starts its own REPL; the one before is stopped so its socket folder goes too.
    await repl?.stop();
    repl = await startRepl(chrome.cdpUrl);
    await repl.run(`tab new ${site.url}/`);
    const sender = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'pw-repl.js'), 'send', '-e', repl.socket, '-t', '30', command]);
    let stdout = '';
    let stderr = '';
    sender.stdout.on('data', d => { stdout += d; });
    sender.stderr.on('data', d => { stderr += d; });
    await waitFor(() => repl.stdout.includes(`[server] ${command}`), 'the command to start');
    await new Promise(r => setTimeout(r, 300));
    stop();
    const code = await new Promise(resolve => sender.on('exit', resolve));
    await waitFor(() => repl.exited, 'the REPL to exit');
    return { code, stdout, stderr };
  };

  it('answers a command that changes the page as not confirmed', async () => {
    const result = await sendThenQuit('click #not-on-the-page');
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stdout, /quit before this command finished; its outcome is unknown/);
    assert.match(result.stderr, /completion not confirmed/);
    assert.doesNotMatch(result.stdout, /Disconnecting/, "the quit's own output is not the sender's");
  });

  it('answers it the same way when the REPL is stopped by a signal', async () => {
    const result = await sendThenQuit('click #not-on-the-page', () => repl.proc.kill('SIGTERM'));
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stdout, /its outcome is unknown/);
  });

  it('answers a read-only command that the browser would never end as interrupted', async () => {
    const result = await sendThenQuit('wait request /never 30');
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /The REPL quit before this command finished\.$/m);
    assert.doesNotMatch(result.stderr, /cannot reach|not answering/);
  });
});

describe('closing the terminal of a serving REPL', { skip: SKIP }, () => {
  let chrome, repl;

  before(async () => {
    chrome = await startChrome();
    repl = await startRepl(chrome.cdpUrl);
  });

  after(async () => {
    await repl?.stop();
    await chrome?.stop();
  });

  it('removes the socket on SIGHUP', async () => {
    assert.ok(fs.existsSync(repl.socket));
    repl.proc.kill('SIGHUP');
    await waitFor(() => repl.exited, 'the REPL to exit');
    assert.equal(fs.existsSync(repl.socket), false);
  });
});
