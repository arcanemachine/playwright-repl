const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

  it('runs the prompt by default, with or without a start URL', () => {
    const env = { ...process.env, PW_CDP_URL: 'http://127.0.0.1:9' };
    for (const args of [[], ['http://example.com']]) {
      const result = pwRepl(args, { env, timeout: 20000 });
      assert.match(result.stdout, /Connecting to http:\/\/127\.0\.0\.1:9/, `pw-repl ${args.join(' ')} starts connecting`);
      assert.notEqual(result.status, 0, 'nothing to connect to');
    }
    assert.match(pwRepl(['sned']).stderr, /Usage:/, 'a mistyped subcommand shows the usage');
  });

  it('mentions help in its own usage', () => {
    assert.match(pwRepl(['--help']).stdout, /pw-repl help \[topic/);
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
    const result = run(['title']);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /not falling back to tmux/);
    assert.doesNotMatch(result.stderr, /no tmux session/);
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
    const result = pwRepl(['send', '-s', session, 'title'], { env, encoding: 'utf8' });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /not at a bare pw> or pw\[serve\]> prompt/);
    const pane = spawnSync('tmux', ['capture-pane', '-t', session, '-p'], { encoding: 'utf8' }).stdout;
    assert.doesNotMatch(pane, /title/, 'nothing was typed into the pane');
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
});
