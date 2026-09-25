// Opt-in command server (pw-repl serve): POST /run {"command": "..."} runs one
// command through the same queue as the prompt and returns its output.
const http = require('http');
const net = require('net');
const fs = require('fs');
const out = require('./output');
const runner = require('./runner');
const { onShutdown, onBeforeExit } = require('./state');
const { parseEndpoint, describe } = require('./client');

const MAX_BODY = 1024 * 1024;
const FLUSH_TIMEOUT = 1000;

// Answers being written, so the REPL can let them reach their senders before it exits.
const sending = new Set();

function send(res, code, result) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  const done = new Promise(resolve => { res.once('finish', resolve); res.once('close', resolve); });
  sending.add(done);
  done.then(() => sending.delete(done));
  res.end(`${JSON.stringify(result)}\n`);
}

onBeforeExit(() => Promise.race([Promise.all(sending), new Promise(resolve => setTimeout(resolve, FLUSH_TIMEOUT))]));

function handle(req, res) {
  // A web page can reach a loopback port; it always sends Origin on a
  // cross-origin POST, and cannot send a JSON content type without a
  // preflight this server never answers.
  if (req.headers.origin) return send(res, 403, { status: 'error', output: 'Requests from web pages are refused' });
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { status: 'ok' });
  if (req.method !== 'POST' || req.url !== '/run') return send(res, 404, { status: 'error', output: 'Use POST /run or GET /health' });
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { status: 'error', output: 'Content-Type must be application/json' });
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => {
    body += chunk;
    if (body.length > MAX_BODY) { send(res, 413, { status: 'error', output: 'Request too large' }); req.destroy(); }
  });
  req.on('end', async () => {
    let command;
    try { ({ command } = JSON.parse(body)); } catch {}
    if (typeof command !== 'string' || !command.trim() || /[\r\n]/.test(command)) {
      return send(res, 400, { status: 'error', output: 'Body must be {"command": "<one line>"}' });
    }
    const result = await runner.submit(command.trim());
    if (!result.uncertain) return send(res, 200, { status: result.status, output: result.output });
    // unconfirmed: the command may or may not have done what it was sent to do.
    if (result.interrupted) return send(res, 200, { status: result.status, output: result.output, unconfirmed: true });
    send(res, 200, { status: result.status, output: `${result.output}\nBrowser command outcome is unknown; the REPL is disconnecting.`, unconfirmed: true });
    runner.giveUp();
  });
}

// A socket file left by a REPL that died is removed; one still answering is not.
async function clearStaleSocket(socketPath) {
  let stat;
  try { stat = fs.statSync(socketPath); } catch { return; }
  if (!stat.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
  const live = await new Promise(resolve => {
    const probe = net.connect(socketPath);
    probe.on('connect', () => { probe.destroy(); resolve(true); });
    probe.on('error', () => resolve(false));
  });
  if (live) throw new Error(`Another REPL is already serving on ${socketPath}`);
  fs.unlinkSync(socketPath);
}

async function serve(endpointArg) {
  const endpoint = parseEndpoint(endpointArg);
  if (endpoint.socket) await clearStaleSocket(endpoint.socket);
  const server = http.createServer(handle);
  // Owner-only from the moment the socket file exists.
  const previousUmask = endpoint.socket ? process.umask(0o177) : null;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      if (endpoint.socket) server.listen(endpoint.socket, resolve);
      else server.listen(endpoint.port, endpoint.host, resolve);
    });
  } finally {
    if (previousUmask !== null) process.umask(previousUmask);
  }
  const removeSocket = () => { if (endpoint.socket) try { fs.unlinkSync(endpoint.socket); } catch {} };
  onShutdown(() => { server.close(); removeSocket(); });
  process.on('exit', removeSocket);
  out.log(`Serving commands on ${describe(endpoint)}`);
}

module.exports = { serve };
