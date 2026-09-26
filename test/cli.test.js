const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SKIP, waitFor, startChrome } = require('./harness');

const BIN = path.join(__dirname, '..', 'bin', 'pw-repl.js');
const pwRepl = (args, options) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });

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

  it('fails for an unknown topic', () => {
    const result = pwRepl(['send', 'help nope'], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /No help for nope/);
  });

  it('prints the skill as it is, with nothing else on stdout', () => {
    const result = pwRepl(['skill']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, fs.readFileSync(path.join(__dirname, '..', 'skill', 'SKILL.md'), 'utf8'));
    assert.match(result.stdout, /^---\nname: pw-repl\ndescription: .+\n---\n/);
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
    const env = { ...process.env, PW_CDP_URL: chrome.cdpUrl, PW_SOCKET: socket, PW_ENDPOINT: '' };
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
      const stopped = pwRepl(['stop'], { env, timeout: 20000 });
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /Stopped the background REPL \(pid \d+\) on \S+repl\.sock/);
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
