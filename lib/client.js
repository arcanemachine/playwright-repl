// How to reach a REPL's command server, and one request to it.
const http = require('http');
const path = require('path');

const DEFAULT_SOCKET = '/tmp/playwright-repl.sock';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

// A port or loopback host:port is TCP; anything else is a unix socket path.
function parseEndpoint(value) {
  if (!value) return { socket: DEFAULT_SOCKET };
  if (/^\d+$/.test(value)) return { host: '127.0.0.1', port: Number(value) };
  const tcp = /^\[?([^\]/]+?)\]?:(\d+)$/.exec(value);
  if (tcp) {
    if (!LOOPBACK.has(tcp[1])) throw new Error(`Refusing non-loopback address ${tcp[1]}; use 127.0.0.1, localhost, or ::1`);
    return { host: tcp[1], port: Number(tcp[2]) };
  }
  return { socket: path.resolve(value) };
}

// Tells an endpoint argument apart from a start URL on the command line.
function looksLikeEndpoint(value) {
  if (value.includes('://')) return false;
  return /^\d+$/.test(value) || /:\d+$/.test(value) || value.endsWith('.sock') || value.startsWith('/') || value.startsWith('.');
}

function describe(endpoint) {
  return endpoint.socket || `${endpoint.host}:${endpoint.port}`;
}

function target(endpoint) {
  return endpoint.socket ? { socketPath: endpoint.socket } : { host: endpoint.host, port: endpoint.port };
}

// GET /health: does not go through the command queue or show in the pane.
function health(endpoint, timeoutMs) {
  return new Promise(resolve => {
    const req = http.get({ ...target(endpoint), path: '/health', timeout: timeoutMs }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// One command. Resolves to { result }, { timeout: true }, { dropped: reason }
// (the connection closed after the command was sent, so it may have run) or
// { unreachable: reason } (it was never sent).
function request(endpoint, command, timeoutMs) {
  return new Promise(resolve => {
    const body = JSON.stringify({ command });
    let connected = false;
    const req = http.request({
      ...target(endpoint),
      path: '/run',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('aborted', () => resolve({ dropped: 'the answer was cut off' }));
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve({ result: JSON.parse(text) }); }
        catch { resolve({ timeout: true }); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ timeout: true }); });
    req.on('socket', socket => socket.once('connect', () => { connected = true; }));
    req.on('error', error => {
      const reason = error.code || error.message;
      resolve(connected ? { dropped: reason } : { unreachable: reason });
    });
    req.end(body);
  });
}

module.exports = { DEFAULT_SOCKET, parseEndpoint, looksLikeEndpoint, describe, health, request };
