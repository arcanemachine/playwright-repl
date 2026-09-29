const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SKIP, waitFor, startChrome, startSite } = require('./harness');

const BIN = path.join(__dirname, '..', 'bin', 'pw-repl.js');
const pwRepl = (args, options) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });
// For a command that loads a page from startSite(), which runs in this process: spawnSync would block it.
const pwReplAsync = (args, { timeout = 30000, ...options } = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});

describe('pw-repl send help', () => {
  const env = { ...process.env, PW_SOCKET: '/nonexistent/pw-sh-test.sock', PW_TMUX_SESSION: 'pw-sh-test-no-such-session', PW_ENDPOINT: '' };
  const help = require('../lib/help');

  it('answers help with no REPL running, from the same help text', () => {
    const overview = pwRepl(['send', 'help'], { env, encoding: 'utf8' });
    assert.equal(overview.status, 0, overview.stderr);
    assert.equal(overview.stdout.trimEnd(), help.render(''));
    assert.equal(pwRepl(['send', 'help route'], { env, encoding: 'utf8' }).stdout.trimEnd(), help.render('route'));
    assert.equal(pwRepl(['send', 'help --all '], { env, encoding: 'utf8' }).stdout.trimEnd(), help.render('--all'));
  });

  it('treats unquoted words as one command', () => {
    assert.equal(pwRepl(['send', 'help', 'quit'], { env, encoding: 'utf8' }).stdout.trimEnd(), help.render('quit'));
  });

  it('ignores playwright-cli\'s --raw', () => {
    assert.equal(pwRepl(['send', '--raw', 'help', 'quit'], { env }).stdout.trimEnd(), help.render('quit'));
  });

  it('says what playwright-cli\'s -s=<session> is here', () => {
    const session = pwRepl(['send', '-s=work', 'tab'], { env });
    assert.equal(session.status, 64);
    assert.match(session.stderr, /-s=work is playwright-cli's session, a browser of its own[\s\S]*-c <name> \(or PW_CLIENT\)/);
  });

  it('fails for an unknown topic', () => {
    const result = pwRepl(['send', 'help nope'], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /No help for nope/);
    assert.match(pwRepl(['send', 'help where'], { env, encoding: 'utf8' }).stdout, /where is run at the shell \(pw-repl where\), not in the REPL; pw-repl --help/);
  });

  it('prints the skill stamped with its version and hash, and where names the same skill', () => {
    const result = pwRepl(['skill']);
    assert.equal(result.status, 0, result.stderr);
    const { version } = require('../package.json');
    const hash = require('../lib/skill').current().hash;
    const file = fs.readFileSync(path.join(__dirname, '..', 'skill', 'SKILL.md'), 'utf8');
    assert.equal(result.stdout, file.replace('<!-- pw-repl skill stamp -->', `This skill is from pw-repl ${version} (skill ${hash}).`));
    assert.match(result.stdout, /^---\nname: pw-repl\ndescription: .+\nallowed-tools: Bash\(pw-repl:\*\) Bash\(npx pw-repl@latest:\*\)\n---\n/);
    const where = pwRepl(['where'], { env: { ...process.env, PW_SOCKET: '/nonexistent/pw-sh-test.sock', PW_TMUX_SESSION: 'pw-sh-test-no-such-session', PW_ENDPOINT: '' } });
    assert.match(where.stdout, new RegExp(`^skill: ${hash} \\(pw-repl ${version.replace(/\./g, '\\.')}\\)\n`));
    assert.match(result.stdout, /\n## Custom rules\n\nNo custom rules have been added yet\.\n$/, 'ends with a place for your own rules');
    assert.equal(result.stderr, '', 'the save hint is for a terminal only');
    assert.match(pwRepl(['skill', 'extra']).stderr, /Usage:/);
  });

  it('shows the usage on its own, and runs the prompt only with run', () => {
    const env = { ...process.env, PW_CDP_URL: 'http://127.0.0.1:9' };
    const bare = pwRepl([], { env });
    assert.equal(bare.status, 0);
    assert.equal(bare.stdout, pwRepl(['help']).stdout, 'the same as pw-repl help');
    assert.doesNotMatch(bare.stdout, /Connecting/);
    for (const args of [['run'], ['run', 'http://example.com']]) {
      const result = pwRepl(args, { env, timeout: 20000 });
      assert.match(result.stdout, /Connecting to http:\/\/127\.0\.0\.1:9/, `pw-repl ${args.join(' ')} starts connecting`);
      assert.notEqual(result.status, 0, 'nothing to connect to');
      assert.match(result.stderr, /No browser answered at http:\/\/127\.0\.0\.1:9 \(connect ECONNREFUSED[\s\S]*--remote-debugging-port=9222/, 'says how to start a browser');
    }
    assert.match(pwRepl(['http://example.com']).stderr, /Usage:/, 'a URL on its own does not connect');
    assert.match(pwRepl(['sned']).stderr, /Usage:/, 'a mistyped subcommand shows the usage');
  });

  it('says why it stops when its input ends', { skip: SKIP }, async () => {
    const chrome = await startChrome();
    try {
      const result = pwRepl(['run'], { env: { ...process.env, PW_CDP_URL: chrome.cdpUrl }, input: '', timeout: 20000 });
      assert.match(result.stderr, /Input ended; disconnecting\./);
    } finally {
      await chrome.stop();
    }
  });

  it('runs in the background, where attach uses it and stop stops it', { skip: SKIP }, async () => {
    const chrome = await startChrome();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-bg-test-'));
    const socket = path.join(dir, 'repl.sock');
    // An ffmpeg that writes its file once its input ends, for a recording stop ends.
    const ffmpeg = path.join(dir, 'ffmpeg');
    fs.writeFileSync(ffmpeg, '#!/bin/sh\ncase "$*" in *-encoders*) echo " V....D libvpx  VP8"; exit 0;; esac\nfor out; do :; done\ncat >/dev/null\nprintf webm > "$out"\n', { mode: 0o755 });
    const env = { ...process.env, PW_CDP_URL: chrome.cdpUrl, PW_SOCKET: socket, PW_ENDPOINT: '', PW_FFMPEG: ffmpeg };
    try {
      const started = pwRepl(['serve', '--background', socket], { env, timeout: 30000 });
      assert.equal(started.status, 0, started.stderr);
      assert.match(started.stdout, /^Serving in the background \(pid \d+\) on \S+repl\.sock\nLog: \S+repl\.log\n/);
      assert.equal(fs.statSync(path.join(dir, 'repl.log')).mode & 0o777, 0o600);
      assert.match(pwRepl(['serve', '--background', socket], { env }).stderr, /already serving on \S+ \(pid \d+\)/, 'one per socket');
      assert.match(pwRepl(['send', 'tab'], { env }).stdout, /\[0\]/, 'send reaches it');
      const unselected = pwRepl(['send', 'info'], { env });
      assert.equal(unselected.status, 1);
      assert.match(unselected.stdout, /No tab is selected/, 'nothing is selected at the start');
      assert.match(fs.readFileSync(path.join(dir, 'repl.log'), 'utf8'), /No tab is selected: tab new \[url\] opens one of your own/);
      assert.equal(pwRepl(['send', 'tab new about:blank'], { env }).status, 0);
      assert.match(pwRepl(['where'], { env }).stdout, /--background\)\nbackground: pid \d+/);

      const attached = spawn(process.execPath, [BIN, 'attach', '-e', socket], { env });
      let seen = '';
      attached.stdout.on('data', d => { seen += d; });
      await waitFor(() => /pw\[attach\]> /.test(seen), 'the attach prompt');
      attached.stdin.write('info\n');
      await waitFor(() => /\[server\] info\n[\s\S]*URL:/.test(seen), 'the command and its output, from the log');
      pwRepl(['send', 'tab'], { env });
      await waitFor(() => /\[server\] tab\n/.test(seen), 'what another sender runs');
      attached.stdin.end();
      assert.equal(await new Promise(resolve => attached.on('exit', resolve)), 0);
      assert.match(seen, /keeps running/);
      assert.match(pwRepl(['send', 'info'], { env }).stdout, /URL:/, 'still running after attach leaves');

      assert.equal(pwRepl(['stop'], { env: { ...env, PW_SOCKET: path.join(dir, 'other.sock') } }).status, 64, 'stop goes by PW_SOCKET, not the default socket');
      // One that ended by itself, unseen, from another client; and one the stop ends.
      assert.equal(pwRepl(['send', '-c', 'other', 'tab new about:blank'], { env }).status, 0);
      assert.equal(pwRepl(['send', '-c', 'other', `record on ${dir}/ended.webm 1`], { env }).status, 0);
      // A file the shell kept whole, spaces and all.
      fs.mkdirSync(path.join(dir, 'my dir'));
      assert.equal(pwRepl(['send', 'record', 'on', `${dir}/my dir/stopped.webm`], { env }).status, 0);
      await waitFor(() => /It reached its 1s and stopped/.test(fs.readFileSync(path.join(dir, 'repl.log'), 'utf8')), 'the 1s recording to end');
      const stopped = pwRepl(['stop'], { env, timeout: 20000 });
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /^Stopped the background REPL \(pid \d+\) on \S+repl\.sock; its log stays at \S+\n/);
      assert.match(stopped.stdout, /\nA recording ended before the REPL stopped, unseen since: It reached its 1s and stopped\. Saved: \S+ended\.webm \(/, 'and says what became of each recording');
      assert.match(stopped.stdout, /\nThe REPL stopped, which ended a recording\. Saved: \S+\/my dir\/stopped\.webm \(/);
      assert.equal(fs.existsSync(socket), false);
      assert.equal(fs.existsSync(path.join(dir, 'repl.pid')), false);
      assert.equal(pwRepl(['stop', '-e', socket], { env }).status, 64);
    } finally {
      pwRepl(['stop', '-e', socket], { env, timeout: 20000 });
      fs.rmSync(dir, { recursive: true, force: true });
      await chrome.stop();
    }
  });

  it('launches a private Chromium with --launch, passes flags after --, and stops it with the REPL', { skip: SKIP }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-launch-test-'));
    const socket = path.join(dir, 'repl.sock');
    const env = { ...process.env, PW_SOCKET: socket, PW_ENDPOINT: '', PW_CDP_URL: 'http://127.0.0.1:9' };
    try {
      assert.equal(pwRepl(['serve', '--background', '--launch', socket, '--', '--window-size=900,700'], { env, timeout: 40000 }).status, 0);
      const log = fs.readFileSync(path.join(dir, 'repl.log'), 'utf8');
      const command = /^  (\S+ .*--user-data-dir=(\S+).*--window-size=900,700 about:blank)$/m.exec(log);
      assert.ok(command, `the command it ran:\n${log}`);
      const url = /Another REPL reaches it with PW_CDP_URL=(\S+)/.exec(log)[1];
      assert.equal(pwRepl(['send', 'tab new about:blank'], { env }).status, 0, 'PW_CDP_URL is not used when it launches');
      assert.match(pwRepl(['where'], { env }).stdout, new RegExp(`^browser: ${url.replace(/[.]/g, '\\.')} answers \\(.*, launched by this REPL\\)$`, 'm'));
      assert.match(pwRepl(['send', 'info'], { env }).stdout, /Viewport: 900x\d+/);
      assert.equal(pwRepl(['stop'], { env, timeout: 20000 }).status, 0);
      assert.equal(fs.existsSync(command[2]), false, 'its profile is removed');
      assert.equal(await fetch(`${url}/json/version`).then(() => 'answers', () => 'gone'), 'gone', 'the browser stopped with the REPL');
    } finally {
      pwRepl(['stop'], { env, timeout: 20000 });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('launches in a profile given with --user-data-dir after --, and keeps it, with what the page saved', { skip: SKIP }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-launch-test-'));
    const site = await startSite();
    const socket = path.join(dir, 'repl.sock');
    const profile = path.join(dir, 'profile');
    const env = { ...process.env, PW_SOCKET: socket, PW_ENDPOINT: '', PW_CDP_URL: 'http://127.0.0.1:9' };
    // A port file an earlier run left behind, naming a port nothing answers on.
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '9\n/devtools/browser/gone\n');
    // A log grown past its limit, from runs long ago.
    fs.writeFileSync(path.join(dir, 'repl.log'), 'old run\n'.repeat(700000));
    try {
      const started = pwRepl(['serve', '--background', '--launch', socket, '--', `--user-data-dir=${profile}`], { env, timeout: 40000 });
      assert.equal(started.status, 0, started.stderr);
      const log = fs.readFileSync(path.join(dir, 'repl.log'), 'utf8');
      assert.doesNotMatch(log, /old run/, 'a log past its limit is moved aside');
      assert.match(fs.readFileSync(path.join(dir, 'repl.log.1'), 'utf8'), /^old run\n/, 'to <log>.1');
      const command = /^  (\S+ .*about:blank)$/m.exec(log)[1];
      assert.deepEqual(command.match(/--user-data-dir=\S+/g), [`--user-data-dir=${profile}`], 'only the profile it was given');
      const url = /Another REPL reaches it with PW_CDP_URL=(\S+)/.exec(log)[1];
      assert.notEqual(new URL(url).port, '9', 'not the port the stale file names');
      const opened = await pwReplAsync(['send', `tab new ${site.url}/other`], { env });
      assert.equal(opened.status, 0, opened.stderr);
      assert.equal(pwRepl(['send', "eval localStorage.setItem('kept', 'yes')"], { env }).status, 0);
      assert.equal(pwRepl(['stop'], { env, timeout: 20000 }).status, 0);
      assert.ok(fs.existsSync(path.join(profile, 'Default')), 'the profile it was given stays');
      assert.deepEqual(fs.readdirSync(profile).filter(name => name.startsWith('Singleton')), [], 'Chromium shut down in order and unlocked the profile');
      assert.equal(await fetch(`${url}/json/version`).then(() => 'answers', () => 'gone'), 'gone', 'the browser stopped with the REPL');
      const again = await pwReplAsync(['serve', '--background', '--launch', socket, `${site.url}/other`, '--', `--user-data-dir=${profile}`], { env, timeout: 40000 });
      assert.equal(again.status, 0, again.stderr);
      const tabs = pwRepl(['send', 'tab'], { env }).stdout;
      // In the order Chromium restores them, which varies.
      assert.deepEqual(tabs.match(/^[* ] \[\d+\] \S+/gm).map(line => line.slice(2).replace(/^\[\d+\] /, '').replace(site.url, '')).sort(), ['/other', '/other', 'about:blank'],
        'its tabs are restored, with no new blank one, and the start URL');
      assert.equal(tabs.match(/\(the start URL\)/g).length, 1);
      assert.match(tabs, /^\* \[\d+\] \S+\/other {2}\(the start URL\)$/m, 'the start URL\'s tab is marked, and selected');
      assert.match(pwRepl(['send', "eval localStorage.getItem('kept')"], { env }).stdout, /yes/, 'localStorage was saved before it stopped');
      const runs = fs.readFileSync(path.join(dir, 'repl.log'), 'utf8');
      assert.equal(runs.match(/^--- \S+ started$/gm).length, 2, 'the log is appended to, run after run');
      assert.equal(runs.match(/^--- \S+ stopped$/gm).length, 1, 'and says where a run stopped');
    } finally {
      pwRepl(['stop'], { env, timeout: 20000 });
      site.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('a --launch that does not start leaves nothing running', () => {
    // A zombie counts as gone: a PID 1 that does not reap orphans (a container without an init) leaves one.
    const alive = pid => {
      try { process.kill(pid, 0); } catch { return false; }
      try { return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return true; }
    };
    // A stand-in for Chromium: it starts a helper process, then does what the script says.
    const fakeChrome = (dir, then) => {
      const exe = path.join(dir, 'chrome');
      fs.writeFileSync(exe, `#!/bin/sh\necho "$@" > ${dir}/args\nsleep 600 &\necho $! > ${dir}/helper.pid\necho $$ > ${dir}/chrome.pid\n${then}\n`, { mode: 0o755 });
      return exe;
    };
    const readPid = file => fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8')) || null;

    it('when Chromium exits before it is up, its helper processes are stopped', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-launch-test-'));
      const env = { ...process.env, PW_CHROME: fakeChrome(dir, 'exit 3'), PW_ENDPOINT: '' };
      try {
        const result = pwRepl(['serve', '--launch', path.join(dir, 'repl.sock')], { env, timeout: 20000 });
        assert.equal(result.status, 1);
        assert.match(result.stdout + result.stderr, /Chromium did not start \(it exited with code 3\)/);
        await waitFor(() => !alive(readPid(path.join(dir, 'helper.pid'))), 'the helper to be stopped', 3000);
      } finally {
        const helper = readPid(path.join(dir, 'helper.pid'));
        if (helper && alive(helper)) process.kill(helper, 'SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    for (const signal of ['SIGTERM', 'SIGINT']) {
      it(`when the REPL gets ${signal} while Chromium starts, Chromium and its profile go too`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-launch-test-'));
        const env = { ...process.env, PW_CHROME: fakeChrome(dir, 'exec sleep 600'), PW_ENDPOINT: '' };
        const repl = spawn(process.execPath, [BIN, 'serve', '--launch', path.join(dir, 'repl.sock')], { env, stdio: 'ignore' });
        try {
          const chrome = await waitFor(() => readPid(path.join(dir, 'chrome.pid')), 'Chromium to start');
          const helper = readPid(path.join(dir, 'helper.pid'));
          const profile = /--user-data-dir=(\S+)/.exec(fs.readFileSync(path.join(dir, 'args'), 'utf8'))[1];
          assert.ok(fs.existsSync(profile));
          repl.kill(signal);
          await waitFor(() => repl.exitCode !== null || repl.signalCode !== null, 'the REPL to exit');
          await waitFor(() => !alive(chrome) && !alive(helper), 'Chromium and its helper to be stopped', 3000);
          assert.equal(fs.existsSync(profile), false, 'its temporary profile is removed');
        } finally {
          repl.kill('SIGKILL');
          for (const name of ['chrome.pid', 'helper.pid']) { const pid = readPid(path.join(dir, name)); if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); }
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    it('when a background start is interrupted while it waits, the REPL and Chromium are stopped', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-launch-test-'));
      const env = { ...process.env, PW_CHROME: fakeChrome(dir, 'exec sleep 600'), PW_ENDPOINT: '' };
      const starting = spawn(process.execPath, [BIN, 'serve', '--background', '--launch', path.join(dir, 'repl.sock')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      starting.stderr.on('data', d => { stderr += d; });
      try {
        const chrome = await waitFor(() => readPid(path.join(dir, 'chrome.pid')), 'Chromium to start');
        const helper = readPid(path.join(dir, 'helper.pid'));
        starting.kill('SIGINT');
        const status = await new Promise(resolve => starting.on('close', resolve));
        assert.equal(status, 130);
        assert.match(stderr, /interrupted; the background REPL was stopped before it served/);
        assert.ok(!alive(chrome) && !alive(helper), 'Chromium and its helper are stopped');
        assert.match(fs.readFileSync(path.join(dir, 'repl.log'), 'utf8'), /^--- \S+ started\n[\s\S]*^--- \S+ stopped\n--- \S+ the start was interrupted\n$/m, 'its log says where it started and stopped, and why');
      } finally {
        starting.kill('SIGKILL');
        for (const name of ['chrome.pid', 'helper.pid']) { const pid = readPid(path.join(dir, name)); if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('retries without the sandbox only once the first try is gone, helpers and all, and keeps a given profile', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-launch-test-'));
      const profile = path.join(dir, 'profile');
      fs.mkdirSync(profile);
      // The first try leaves a helper behind and fails for want of a sandbox; the retry notes whether it is still there.
      const exe = fakeChrome(dir, `if [ -f ${dir}/first ]; then p=$(cat ${dir}/first); if kill -0 $p 2>/dev/null && ! grep -q '^State:.*Z' /proc/$p/status 2>/dev/null; then echo alive; else echo gone; fi > ${dir}/retry; exit 3; fi
cp ${dir}/helper.pid ${dir}/first; echo 'No usable sandbox!' >&2; exit 1`);
      const env = { ...process.env, PW_CHROME: exe, PW_ENDPOINT: '' };
      try {
        const result = pwRepl(['serve', '--launch', path.join(dir, 'repl.sock'), '--', `--user-data-dir=${profile}`], { env, timeout: 20000 });
        assert.equal(result.status, 1);
        assert.match(result.stdout + result.stderr, /Chromium did not start \(it exited with code 3\):\n.*--no-sandbox/);
        assert.equal(fs.readFileSync(path.join(dir, 'retry'), 'utf8').trim(), 'gone', 'the first try\'s helper was stopped before the retry');
        assert.ok(fs.existsSync(profile), 'the profile it was given stays');
      } finally {
        for (const name of ['first', 'helper.pid']) { const pid = readPid(path.join(dir, name)); if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('refuses Chromium flags without --launch', () => {
    assert.match(pwRepl(['run', '--', '--lang=fr']).stderr, /Usage:/);
    assert.match(pwRepl(['run', '--headed']).stderr, /Usage:/);
  });

  it('mentions help in its own usage', () => {
    assert.match(pwRepl(['--help']).stdout, /pw-repl help \[topic/);
    const bare = pwRepl(['help']);
    assert.equal(bare.status, 0);
    assert.match(bare.stdout, /^Usage:\n  pw-repl run \[--launch \[--headed\]\] \[start-url\][\s\S]*\n\nThe REPL's own commands: help at the pw> prompt, or pw-repl send help/, 'help at the shell is the usage');
    assert.equal(pwRepl(['help', 'route']).stdout.trimEnd(), require('../lib/help').render('route'), 'with a command, the REPL help');
    assert.equal(pwRepl(['help', '-h']).stdout, bare.stdout, 'help -h is the usage too');
  });

  it('refuses an address that is not loopback as a usage error, not a stack trace', () => {
    const env = { ...process.env, PW_ENDPOINT: '' };
    for (const args of [['send', '-e', '10.0.0.1:9230', 'tab'], ['where', '-e', '10.0.0.1:9230'], ['stop', '-e', '10.0.0.1:9230'], ['attach', '-e', '10.0.0.1:9230']]) {
      const result = pwRepl(args, { env });
      assert.equal(result.status, 64, args.join(' '));
      assert.equal(result.stderr, 'pw-repl: Refusing non-loopback address 10.0.0.1; use 127.0.0.1, localhost, or ::1\n', args.join(' '));
    }
    const byEnv = pwRepl(['send', 'tab'], { env: { ...process.env, PW_ENDPOINT: '10.0.0.1:9230' } });
    assert.equal(byEnv.status, 64, 'from PW_ENDPOINT too');
    assert.match(byEnv.stderr, /^pw-repl: Refusing non-loopback address 10\.0\.0\.1;/);
  });
});

// A socket file with nothing behind it: what a REPL killed mid-shutdown leaves.
describe('pw-repl send with a socket that no longer answers', () => {
  let dir, socket;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sh-test-'));
    socket = path.join(dir, 'stale.sock');
    const holder = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socket)}, () => console.log('up'))`]);
    await new Promise(resolve => holder.stdout.once('data', resolve));
    holder.kill('SIGKILL');
    await new Promise(resolve => holder.once('exit', resolve));
    assert.ok(fs.statSync(socket).isSocket());
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = args => pwRepl(['send', ...args], {
    env: { ...process.env, PW_SOCKET: socket, PW_TMUX_SESSION: 'pw-sh-test-no-such-session', PW_ENDPOINT: '' },
    encoding: 'utf8',
  });

  it('fails instead of falling back to tmux', () => {
    const result = run(['info']);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /cannot reach the REPL server at \S+stale\.sock \(ECONNREFUSED\)/);
    assert.doesNotMatch(result.stderr, /tmux/);
  });

  it('does not fall back to tmux when PW_SOCKET names a socket that is gone', () => {
    const result = pwRepl(['send', 'info'], { env: { ...process.env, PW_SOCKET: path.join(dir, 'gone.sock'), PW_TMUX_SESSION: 'pw-sh-test-no-such-session', PW_ENDPOINT: '' } });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /no REPL is serving on \S+gone\.sock \(there is no socket\)/);
    assert.doesNotMatch(result.stderr, /tmux/);
  });

  it('says so with where', () => {
    const result = pwRepl(['where'], { env: { ...process.env, PW_SOCKET: socket, PW_TMUX_SESSION: 'pw-sh-test-no-such-session', PW_ENDPOINT: '' } });
    assert.match(result.stderr, /not answering/);
  });
});

// serve takes its socket before it reaches the browser, so it is not taken for a REPL without one.
describe('pw-repl serve while it connects', () => {
  let dir, socket, hanging, repl;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sh-test-'));
    socket = path.join(dir, 'starting.sock');
    // A browser address that takes the connection and never answers.
    hanging = require('net').createServer(() => {});
    await new Promise(resolve => hanging.listen(0, '127.0.0.1', resolve));
    repl = spawn(process.execPath, [BIN, 'serve', socket], { env: { ...process.env, PW_CDP_URL: `http://127.0.0.1:${hanging.address().port}` }, stdio: ['pipe', 'ignore', 'ignore'] });
    await waitFor(() => fs.existsSync(socket), 'the socket');
  });

  after(async () => {
    if (repl.exitCode === null) { repl.kill(); await new Promise(resolve => repl.once('exit', resolve)); }
    hanging.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const env = () => ({ ...process.env, PW_SOCKET: socket, PW_TMUX_SESSION: 'pw-sh-test-no-such-session', PW_ENDPOINT: '' });

  it('says it is starting, with where and with send, and runs nothing', async () => {
    const where = await pwReplAsync(['where'], { env: env() });
    assert.equal(where.status, 64);
    assert.match(where.stdout, /server: \S+starting\.sock \(the REPL was started with pw-repl serve and is starting: connecting to the browser; retry shortly\)/);
    const sent = await pwReplAsync(['send', '-c', 'me', 'tab'], { env: env() });
    assert.equal(sent.status, 64);
    assert.match(sent.stderr, /The REPL is starting \(connecting to the browser\); retry shortly/);
    assert.doesNotMatch(sent.stderr, /-c needs/);
  });

  it('removes its socket when stopped before it serves', async () => {
    repl.kill('SIGTERM');
    await new Promise(resolve => repl.once('exit', resolve));
    assert.equal(fs.existsSync(socket), false);
  });
});

// A REPL that goes away after taking the command: it may have run it.
describe('pw-repl send when the connection drops after sending', () => {
  let dir, socket, holder;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sh-test-'));
    socket = path.join(dir, 'drop.sock');
    holder = spawn(process.execPath, ['-e', `require('net').createServer(c => c.once('data', () => c.destroy())).listen(${JSON.stringify(socket)}, () => console.log('up'))`]);
    await new Promise(resolve => holder.stdout.once('data', resolve));
  });

  after(() => { holder.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('reports completion not confirmed, not unreachable', async () => {
    const sender = spawn(process.execPath, [BIN, 'send', '-e', socket, 'click #x'], { encoding: 'utf8' });
    let stderr = '';
    sender.stderr.on('data', d => { stderr += d; });
    const code = await new Promise(resolve => sender.on('exit', resolve));
    assert.equal(code, 2, stderr);
    assert.match(stderr, /completion not confirmed: the REPL closed the connection/);
  });
});

const HAS_TMUX = spawnSync('tmux', ['-V']).status === 0;

// A pane running node that is not at the REPL prompt: a busy or exiting REPL looks like this.
describe('pw-repl send typing into a tmux pane', { skip: HAS_TMUX ? false : 'tmux is not installed' }, () => {
  const env = { ...process.env, PW_SOCKET: '/nonexistent/pw-sh-test.sock', PW_ENDPOINT: '' };
  const sessions = [];

  // A node process whose last printed line is `line`, standing in for a REPL in that state.
  async function paneShowing(line) {
    const session = `pw-sh-test-${process.pid}-${sessions.length}`;
    sessions.push(session);
    const script = `process.stdout.write(${JSON.stringify(line)}); setInterval(() => {}, 1000)`;
    spawnSync('tmux', ['new-session', '-d', '-s', session, `${process.execPath} -e '${script}'`]);
    await new Promise(resolve => setTimeout(resolve, 500));
    return session;
  }

  after(() => sessions.forEach(session => spawnSync('tmux', ['kill-session', '-t', session])));

  const refuses = session => {
    const result = pwRepl(['send', '-s', session, 'info'], { env, encoding: 'utf8' });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /not at a bare pw> or pw\[serve\]> prompt/);
    const pane = spawnSync('tmux', ['capture-pane', '-t', session, '-p'], { encoding: 'utf8' }).stdout;
    assert.doesNotMatch(pane, /info/, 'nothing was typed into the pane');
  };

  it('refuses when the REPL is printing something else', async () => {
    refuses(await paneShowing('shutting down'));
  });

  it('refuses when the disconnect message is on the prompt line', async () => {
    refuses(await paneShowing('pw> Browser command outcome is unknown; disconnecting instead of continuing.'));
  });

  it('refuses the server prompt with something on it too', async () => {
    refuses(await paneShowing('pw[serve]> [server] requests'));
  });

  it('refuses when someone is typing at the prompt', async () => {
    refuses(await paneShowing('pw> half-typed'));
  });

  it('refuses a mode list that is not before the prompt', async () => {
    refuses(await paneShowing('pw> (watch)'));
  });

  // A stand-in REPL that answers each command with its completion marker.
  it('types at a prompt with modes before it', async () => {
    const session = `pw-sh-test-${process.pid}-${sessions.length}`;
    sessions.push(session);
    const script = `const p = "(watch routes:1) pw> "; process.stdout.write(p); require("readline").createInterface({ input: process.stdin }).on("line", l => { const id = /^@(\\S+)/.exec(l)[1]; process.stdout.write("answered\\n[[pw-done:" + id + ":ok]]\\n" + p); })`;
    spawnSync('tmux', ['new-session', '-d', '-s', session, `${process.execPath} -e '${script}'`]);
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = pwRepl(['send', '-s', session, '-t', '5', 'info'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /answered/);
  });
});
