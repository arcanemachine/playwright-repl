// Routes: faking, patching, delaying or failing a tab's requests.
const { state } = require('./state');
const out = require('./output');
const { unquote, splitSelector } = require('./syntax');
const { hints } = require('./util');
const { tabState } = require('./tabstate');
const { markChanged, requestEntries } = require('./requestlog');

// Playwright routes are registered per page, so the listing is too.
const ROUTE_PREVIEW = 80;

function routesFor(p) {
  if (!('routes' in tabState(p))) tabState(p).routes = new Map();
  return tabState(p).routes;
}

const ROUTE_DELAY_MAX = 120;

// A JSON Merge Patch (RFC 7386): objects merge, null removes a key, anything else replaces.
function mergePatch(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

function parseJson(text, what) {
  try { return JSON.parse(text); } catch (error) { throw new Error(`${what} is not valid JSON: ${error.message}`); }
}

// How a route treats the requests it matches: its text for listing, and what it does to each one.
function routeKind(how, rest, usage) {
  if (/^\d{3}$/.test(how)) {
    const status = Number(how);
    if (status < 200 || status > 599) throw new Error('Status must be from 200 to 599');
    // JSON unless its type is given, so a typo in the JSON is not served as text.
    const typed = /^--content-type=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)(?:\s+([\s\S]*))?$/.exec(rest || '');
    const body = typed ? typed[2] || '' : rest || '';
    if (!typed && body) {
      try { JSON.parse(body); } catch (error) {
        throw new Error(`Body is not valid JSON: ${error.message}; for another kind, give its type: route <url-glob> <status> --content-type=text/plain <body>`);
      }
    }
    // Quoted when it has a parameter: --content-type="text/html; charset=utf-8".
    const contentType = typed ? unquote(typed[1]) : body ? 'application/json' : undefined;
    const preview = body.length > ROUTE_PREVIEW ? `${body.slice(0, ROUTE_PREVIEW)}…` : body;
    return {
      text: `${status}${typed ? ` (${contentType})` : ''}${preview ? ` ${preview}` : ''}`,
      async handle(r, req, tag, notice) {
        markChanged(req, status, 'faked');
        await r.fulfill({ status, contentType, body });
        notice(`Faked: ${tag()} -> ${status}`);
      },
    };
  }
  if (how === 'patch') {
    if (!rest) throw new Error(usage);
    // Anything but an object replaces the whole body, as RFC 7386 has it: the way to change an array.
    const patch = parseJson(rest, 'Patch');
    return {
      text: `patch ${rest.length > ROUTE_PREVIEW ? `${rest.slice(0, ROUTE_PREVIEW)}…` : rest}`,
      async handle(r, req, tag, notice) {
        const response = await r.fetch();
        let body;
        try { body = await response.json(); } catch {
          await r.fulfill({ response });
          notice(`Not patched: ${tag()} — its response is not JSON, so it went through unchanged`);
          return;
        }
        markChanged(req, response.status(), 'patched');
        await r.fulfill({ response, json: mergePatch(body, patch) });
        notice(`Patched: ${tag()} -> ${response.status()}`);
      },
    };
  }
  if (how === 'delay') {
    const seconds = Number(rest);
    if (!/^\d+(?:\.\d+)?$/.test(rest || '') || seconds <= 0 || seconds > ROUTE_DELAY_MAX) throw new Error(`Usage: route <url-glob> delay <seconds> (up to ${ROUTE_DELAY_MAX})`);
    return {
      text: `delay ${seconds}s`,
      async handle(r, req, tag, notice) {
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        await r.continue();
        notice(`Delayed ${seconds}s: ${tag()}`);
      },
    };
  }
  if (how === 'abort' && !rest) {
    return {
      text: 'abort',
      async handle(r, req, tag, notice) {
        await r.abort('failed');
        notice(`Aborted: ${tag()}`);
      },
    };
  }
  throw new Error(usage);
}

function listRoutes() {
  const routes = routesFor(state.page);
  const forms = [
    ['route <url-glob> <status> [json-body]', 'answer it with this status and JSON'],
    ['route <url-glob> <status> --content-type=<type> <body>', 'or with a body of another type'],
    ['route <url-glob> patch <json>', 'let it through, then change its JSON'],
    ['route <url-glob> delay <seconds>', 'hold it, then let it through'],
    ['route <url-glob> abort', 'fail it as if the connection broke'],
  ];
  if (!routes.size) {
    out.log('No routes on the selected tab.');
    out.log(hints(forms));
    return;
  }
  out.log(`Routes on the selected tab (${routes.size}):`);
  const width = Math.max(...[...routes.keys()].map(glob => glob.length));
  for (const [glob, { text }] of routes) out.log(`  ${glob.padEnd(width)}  ${text}`);
  out.log(hints([...forms, ['route off <url-glob> | route off --all', 'remove']]));
}

async function removeRoutes(glob) {
  if (!glob) throw new Error('Usage: route off <url-glob> | route off --all');
  const routes = routesFor(state.page);
  if (glob !== '--all' && !routes.has(glob)) throw new Error(`No route for ${glob} on the selected tab`);
  const removed = await unroute(state.page, glob === '--all' ? [...routes.keys()] : [glob]);
  for (const g of removed) out.log(`Removed: ${g}`);
  if (!removed.length) out.log('No routes on the selected tab');
}

async function unroute(p, globs) {
  const routes = routesFor(p);
  for (const g of globs) {
    await p.unroute(g, routes.get(g).handler);
    routes.delete(g);
  }
  return globs;
}

const commands = {
  // Fulfilled inside the browser, so the page's own code handles the fake
  // exactly as a real response and the request never reaches the network.
  async route(args) {
    const trimmed = (args || '').trim();
    if (!trimmed) return listRoutes();
    // A glob may be quoted, as it is in a shell.
    const off = /^off(?:\s+(\S+))?$/.exec(trimmed);
    if (off) return removeRoutes(off[1] && unquote(off[1]));
    const usage = 'Usage: route <url-glob> <status> [json-body] | route <url-glob> patch <json> | route <url-glob> delay <seconds> | route <url-glob> abort | route off <url-glob>|--all';
    const parsed = splitSelector(trimmed);
    const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(parsed?.rest || '');
    if (!match) throw new Error(usage);
    const glob = parsed.word;
    const [, how, rest] = match;
    const route = routeKind(how, rest, usage);
    const routes = routesFor(state.page);
    const previous = routes.get(glob);
    if (previous) await state.page.unroute(glob, previous.handler);
    const page = state.page;
    const notice = text => out.notice(text, page);
    const handler = async r => {
      const req = r.request();
      const tag = () => { const id = requestEntries.get(req)?.id; return `${id ? `#${id} ` : ''}${req.method()} ${req.url()}`; };
      try {
        await route.handle(r, req, tag, notice);
      } catch (error) {
        // Aborted, never continued: a request meant to be changed must not reach the page as it was.
        await r.abort().catch(() => {});
        notice(`Route failed: ${tag()} — ${error.message}; the request was aborted`);
      }
    };
    await state.page.route(glob, handler);
    routes.set(glob, { text: route.text, handler, owner: state.client });
    out.log(`${previous ? 'Replaced' : 'Routed'}: ${glob} -> ${route.text}`);
  },
};

module.exports = { commands, routesFor, unroute };
