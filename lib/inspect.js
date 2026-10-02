// Reading the page: text, attributes, snapshots, screenshots, eval and CDP, cookies and storage, and waits.
const path = require('path');
const fs = require('fs');
const { state, withTimeout } = require('./state');
const out = require('./output');
const { printOutput } = out;
const { devices } = require('playwright-core');
const { toSelector, REF, unquote } = require('./syntax');
const { regexOf, COMMAND_TIMEOUT } = require('./util');
const { tabState } = require('./tabstate');
const { keptSession } = require('./cdp');
const { CDP_REFUSED } = require('./dialogs');
const { onElement, soleSelector } = require('./elements');
const { waitForLoad, waitForRequest } = require('./requestlog');
const { deviceMetrics, viewportMetrics, reapplyMetrics } = require('./emulation');

const SCREENSHOT_DELAY_MAX = 60;

function nextScreenshotPath(name) {
  const filename = name ? `screenshot-${name}` : `screenshot-${Date.now()}`;
  // A REPL on a socket of its own keeps its screenshots next to it, as its log is.
  return path.join(process.env.PW_SCREENSHOT_DIR || state.ownDir || '/tmp', `${filename}.png`);
}

// A screenshot of an emulated phone, taken by Chrome as it draws it. Playwright's own sizes the page
// again for the shot, and a page with no viewport meta tag, laid out wider than the phone and shown
// shrunk, comes out drawn small in a corner of a mostly blank image. One image pixel per CSS pixel.
async function deviceShot(device, { ref, full, type }) {
  const session = await keptSession(state.page);
  let clip = null;
  if (ref) {
    const selector = toSelector(ref);
    const box = await onElement(selector, async () => {
      const locator = state.page.locator(selector);
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
      return locator.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; }, null, { timeout: 5000 });
    });
    clip = box;
  }
  // Measured after scrolling to the element, if any.
  const { cssVisualViewport: view, cssContentSize: content } = await session.send('Page.getLayoutMetrics');
  // At the size the phone shows it: a page laid out wider than the phone is shown shrunk (view.scale).
  const scale = view.scale / devices[device].deviceScaleFactor;
  if (clip) clip = { ...clip, scale };
  if (full) clip = { x: 0, y: 0, width: content.width, height: content.height, scale };
  if (!clip) clip = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale };
  // Beyond the visible area, Chrome lays the page out again at its whole size for the shot, which
  // someone looking at it would see move: only for --full, and an element that does not fit.
  const inView = clip.x >= view.pageX && clip.y >= view.pageY && clip.x + clip.width <= view.pageX + view.clientWidth && clip.y + clip.height <= view.pageY + view.clientHeight;
  const { data } = await session.send('Page.captureScreenshot', { format: type, clip, captureBeyondViewport: full || (!!ref && !inView) });
  return Buffer.from(data, 'base64');
}

// An element bigger than the viewport is taken with the page laid out again at its whole size, where
// the page's scrollbar is gone and what was beside it moves over by its width, after the element was
// measured: the shot came out shifted. Laid out without the scrollbar for the shot, by a stylesheet
// adopted for it (under any CSP), the element is measured where it is taken. Someone looking at the
// page sees its scrollbar go for a moment.
const NO_SCROLLBAR = 'html:not([data-pw-repl])';
async function elementShot(locator, type) {
  const fits = await locator.evaluate(el => { const r = el.getBoundingClientRect(); return r.width <= innerWidth && r.height <= innerHeight; }, null, { timeout: 5000 });
  if (fits) return locator.screenshot({ type, timeout: 5000 });
  const sheet = hide => state.page.evaluate(([rule, on]) => {
    const sheets = [...document.adoptedStyleSheets].filter(s => ![...s.cssRules].some(r => r.selectorText === rule));
    if (on) {
      const s = new CSSStyleSheet();
      s.replaceSync(`${rule} { scrollbar-width: none !important; }`);
      sheets.push(s);
    }
    document.adoptedStyleSheets = sheets;
  }, [NO_SCROLLBAR, hide]);
  await sheet(true);
  try {
    return await locator.screenshot({ type, timeout: 5000 });
  } finally {
    await sheet(false).catch(() => {});
  }
}

// Unnamed generic nodes are layout wrappers (mostly divs): they add depth and
// nothing to read. Drop them, lift their children, and drop cursor hints.
function compactSnapshot(text) {
  const dropped = [];
  const lines = [];
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length;
    while (dropped.length && dropped[dropped.length - 1] >= indent) dropped.pop();
    if (/^- generic(?: \[[^\]]+\])*:?$/.test(line.trim())) { dropped.push(indent); continue; }
    lines.push(' '.repeat(Math.max(0, indent - 2 * dropped.length)) + line.trimStart().replace(/ \[cursor=pointer\]/g, ''));
  }
  return lines.join('\n');
}

const WAIT_DEFAULT = 10;
const WAIT_MAX = 120;

// Gone once no match is visible, whether it was removed or hidden.
async function waitGone(locator, what, timeout) {
  try {
    await locator.filter({ visible: true }).first().waitFor({ state: 'detached', timeout });
  } catch (error) {
    if (/Timeout \d+ms exceeded/.test(error.message)) throw new Error(`Still visible after ${timeout / 1000}s: ${what}`);
    throw error;
  }
  out.log(`Gone: ${what}`);
}

const SNAPSHOT_HINT_LINES = 60;

// Each matching line (any part of it: role, name, flags such as [disabled]),
// with the named elements it sits in, so a match can be placed without the
// rest of the tree.
// needle: text to find in any case, or a RegExp.
function grepSnapshot(text, needle) {
  const lower = typeof needle === 'string' ? needle.toLowerCase() : null;
  const matches = line => (lower === null ? needle.test(line) : line.toLowerCase().includes(lower));
  const stack = [];
  const hits = [];
  const label = line => line.trim().replace(/^- /, '').replace(/:$/, '').replace(/^'(.*)'$/, '$1');
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (matches(line)) {
      const around = stack.filter(a => !/^generic(?: \[|$)/.test(a.label));
      // A hit with no ref of its own (text) keeps the ref of what holds it, so
      // snapshot <ref> can show what sits beside it: the value next to a label.
      const own = /\[ref=/.test(line);
      const path = around.map((a, i) => (!own && i === around.length - 1 ? a.label : a.label.replace(/ \[ref=[^\]]+\]/g, '')));
      hits.push([...path, label(line)].join(' › '));
    }
    stack.push({ indent, label: label(line) });
  }
  return hits;
}

// A function written out (el => ..., function (el) {...}), as one expression.
function isFunctionText(text) {
  // Wrapped in parentheses, as (el => el.id) is often written: only when the first one closes at the end.
  const wrapped = /^\s*\(([\s\S]*)\)\s*$/.exec(text);
  if (wrapped && closesAtEnd(text.trim()) && isFunctionText(wrapped[1])) return true;
  if (!/^\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(text)) return false;
  try { new Function(`return (${text}\n);`); return true; } catch { return false; }
}

// Whether the opening parenthesis is matched by the last character, not earlier: (a)(b) is a call.
function closesAtEnd(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') { depth -= 1; if (depth === 0) return i === text.length - 1; }
  }
  return false;
}

const commands = {
  async text(args, all) {
    const selector = soleSelector(args, 'text <selector>');
    printOutput(await onElement(selector, () => state.page.innerText(selector, { timeout: 5000 })), all);
  },

  async html(args, all) {
    const selector = soleSelector(args, 'html <selector>');
    printOutput(await onElement(selector, () => state.page.$eval(selector, el => el.outerHTML)), all);
  },

  async attrs(args, all) {
    const selector = soleSelector(args, 'attrs <selector>');
    const result = await onElement(selector, () => state.page.$eval(selector, el => {
      const out = {};
      for (const attr of el.attributes) out[attr.name] = attr.value;
      return out;
    }));
    printOutput(result, all);
  },

  // The page's own event listeners on an element, which only DevTools can
  // list: the element is handed to a CDP session through the page, so any
  // Playwright selector works, and the session asks for its listeners.
  async listeners(args, all) {
    const text = (args || '').trim();
    const usage = 'listeners <selector> | listeners document | listeners window';
    if (!text) throw new Error(`Usage: ${usage}`);
    const which = text === 'document' || text === 'window' ? text : null;
    const selector = which ? null : soleSelector(args, usage);
    if (selector) await onElement(selector, () => state.page.locator(selector).first().evaluate(el => { window.__pwReplListenersOf = el; }, null, { timeout: 5000 }));
    const cdp = await state.page.context().newCDPSession(state.page);
    try {
      // Chrome includes each handler's source only for an object in a named group.
      const { result } = await cdp.send('Runtime.evaluate', { expression: which || 'window.__pwReplListenersOf', objectGroup: 'pw-repl-listeners' });
      if (!result.objectId) throw new Error(`No element matches ${text}`);
      const { listeners: found } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      // Playwright adds its own to window once it has acted on the page; they are not the page's.
      // Told by the script they come from, the one its hit-target check is in.
      const own = new Set(found.filter(l => /^__playwright_/.test(l.type) || /_hitTargetInterceptor/.test(l.handler?.description || '')).map(l => l.scriptId));
      const listeners = found.filter(l => !own.has(l.scriptId));
      const note = found.length > listeners.length ? ` (${found.length - listeners.length} of Playwright's own left out)` : '';
      if (!listeners.length) { out.log(`No event listeners on ${text}${note}`); return; }
      const lines = listeners.map(l => {
        const how = [l.useCapture && 'capture', l.once && 'once', l.passive && 'passive'].filter(Boolean).join(', ');
        const source = l.handler?.description || '';
        // Whole, as written, with its lines indented; or its start on one line, where ↵ marks each
        // line break, so a // comment is seen to end there.
        const text = all
          ? source.split('\n').map((line, i) => (i ? `    ${line}` : line)).join('\n')
          : source.replace(/[ \t]*\r?\n\s*/g, ' ↵ ').replace(/[ \t]+/g, ' ');
        const handler = all || text.length <= 100 ? text : `${text.slice(0, 100)}…`;
        return `${l.type}${how ? ` (${how})` : ''}: ${handler} (line ${l.lineNumber + 1})`;
      });
      printOutput(lines.join('\n'), all);
      if (note) out.log(note.trim());
    } finally {
      await cdp.send('Runtime.evaluate', { expression: 'delete window.__pwReplListenersOf' }).catch(() => {});
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'pw-repl-listeners' }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
  },

  async count(args) {
    const selector = soleSelector(args, 'count <selector>');
    const els = await state.page.$$(selector);
    out.log(`${els.length} element(s)`);
  },

  async visible(args) {
    const selector = soleSelector(args, 'visible <selector>');
    const el = await state.page.$(selector);
    if (!el) { out.log('Not found'); return; }
    out.log(await el.isVisible() ? 'visible' : 'hidden');
  },

  async links(_args, all) {
    const links = await state.page.$$eval('a[href]', els =>
      els.map(e => ({ text: e.textContent.trim(), href: e.href }))
        .filter(l => l.text)
    );
    if (!links.length) { out.log('No links found'); return; }
    printOutput(links, all);
  },

  async inputs(_args, all) {
    const inputs = await state.page.$$eval('input, select, textarea', els =>
      els.map(e => ({
        tag: e.tagName.toLowerCase(),
        type: e.type || '',
        name: e.name || '',
        id: e.id || '',
        placeholder: e.placeholder || '',
        disabled: e.disabled,
        autocomplete: e.autocomplete || ''
      }))
    );
    if (!inputs.length) { out.log('No inputs found'); return; }
    printOutput(inputs, all);
  },

  async screenshot(args) {
    const usage = 'Usage: screenshot [<ref>] [--full] [--delay|-d <seconds>] [name | --filename=<file>]\nNames may contain letters, digits, underscores, and hyphens.';
    // The file first: a path may be quoted, with spaces in it.
    let file = null;
    const rest = (args || '').replace(/(?:^|\s)--filename(?:=|\s+)("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/, (_, value) => { file = unquote(value); return ' '; });
    const tokens = rest.trim().split(/\s+/).filter(Boolean);
    let full = false;
    let delay = 0;
    let ref = null;
    const names = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      // --full-page and --filename are playwright-cli's.
      if (token === '--full' || token === '--full-page') { full = true; continue; }
      if (token === '--filename' || token.startsWith('--filename=')) throw new Error(usage);
      if (!ref && !names.length && REF.test(token)) { ref = token; continue; }
      if (token === '--delay' || token === '-d') {
        const value = tokens[++i];
        // Capped low on purpose: a timed shot is human-in-the-loop, and a typo
        // like `-d 300` would otherwise park the serialized command queue.
        if (!value || !/^\d+$/.test(value) || Number(value) > SCREENSHOT_DELAY_MAX) throw new Error(`Usage: screenshot --delay <seconds> (maximum ${SCREENSHOT_DELAY_MAX})`);
        delay = Number(value);
        continue;
      }
      names.push(token);
    }
    if (names.length > 1 || (names[0] && !/^[a-zA-Z0-9_-]+$/.test(names[0])) || (file && names.length) || (ref && full)) throw new Error(usage);
    const name = names[0] || null;
    // Counted down out loud so a watcher can time a hover or menu state, and so
    // the wait is distinguishable from a hung command in a tmux capture.
    for (let remaining = delay; remaining > 0; remaining--) {
      out.log(`${remaining}...`);
      await state.page.waitForTimeout(1000);
    }
    // Named after the countdown so a default filename timestamps the capture.
    // A file given is relative to the REPL's folder; pw-repl send makes it the sender's.
    const filepath = file ? path.resolve(file) : nextScreenshotPath(name);
    const type = /\.jpe?g$/i.test(filepath) ? 'jpeg' : 'png';
    // Checked before the tab is brought to the front, which can move someone's view.
    if (fs.existsSync(filepath)) throw new Error(`Screenshot already exists: ${filepath}`);
    if (!fs.existsSync(path.dirname(filepath))) throw new Error(`No folder ${path.dirname(filepath)} to save ${path.basename(filepath)} in`);
    // Chrome does not draw a tab that is not in front, and tabs open in the
    // background, so the tab is brought to the front for the shot.
    await state.page.bringToFront();
    // A tab brought to the front before can be drawn at the window's size since its last navigation.
    await reapplyMetrics(state.page);
    let image;
    const device = tabState(state.page).emulation?.device;
    try {
      if (device) {
        image = await deviceShot(device, { ref, full, type });
      } else if (ref) {
        const selector = toSelector(ref);
        image = await onElement(selector, () => elementShot(state.page.locator(selector), type));
      } else {
        image = await state.page.screenshot({ fullPage: full, type });
      }
    } finally {
      // Playwright's screenshot resets the screen size and pixel ratio it
      // finds; an emulated phone's, or a viewport's, are set again.
      const viewport = tabState(state.page).viewport;
      if (device || viewport) {
        const session = await keptSession(state.page);
        await session.send('Emulation.clearDeviceMetricsOverride');
        await (device ? deviceMetrics(session, device) : viewportMetrics(session, viewport));
      }
    }
    try {
      fs.writeFileSync(filepath, image, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Screenshot already exists: ${filepath}`);
      throw error;
    }
    out.log(`Saved: ${filepath}`);
  },

  async snapshot(args, all) {
    let rest = (args || '').trim();
    const full = /^--full(?:\s|$)/.test(rest);
    if (full) rest = rest.slice(6).trim();
    let needle = null;
    const grep = /^--(grep|regex)(?:\s|$)/.exec(rest);
    if (grep) {
      needle = rest.slice(grep[0].length).trim().replace(/^(["'])(.*)\1$/, '$2').replace(/\\"/g, '"');
      if (!needle) throw new Error(`Usage: snapshot [--full] --${grep[1]} <${grep[1] === 'grep' ? 'text' : 'pattern'}>`);
      if (grep[1] === 'regex') needle = regexOf(needle);
      rest = '';
    }
    // Playwright's labels are e5, or frame-prefixed like f1e5 in newer versions.
    const selector = toSelector(rest);
    let raw;
    // A snapshot of one element gives the page new refs, and those of the last whole-page snapshot
    // stop working; so a ref's part is cut from a whole-page snapshot, which keeps them.
    if (REF.test(rest)) {
      const lines = (await state.page.ariaSnapshot({ mode: 'ai', timeout: 5000 })).split('\n');
      const at = lines.findIndex(line => line.includes(`[ref=${rest}]`));
      if (at === -1) throw new Error(`No element matches ${rest}\n${rest} is a snapshot ref; if the page changed since that snapshot, take a new one.`);
      const indent = line => line.length - line.trimStart().length;
      const end = lines.findIndex((line, i) => i > at && indent(line) <= indent(lines[at]));
      raw = lines.slice(at, end === -1 ? undefined : end).map(line => line.slice(indent(lines[at]))).join('\n');
    } else if (selector) {
      raw = await onElement(selector, () => state.page.locator(selector).first().ariaSnapshot({ mode: 'ai', timeout: 5000 }));
    } else {
      raw = await state.page.ariaSnapshot({ mode: 'ai', timeout: 5000 });
    }
    const text = full ? raw : compactSnapshot(raw);
    if (needle !== null) {
      const hits = grepSnapshot(text, needle);
      if (!hits.length) { out.log(`No snapshot lines match ${needle}`); return; }
      printOutput(hits.join('\n'), all);
      return;
    }
    const lines = text.split('\n').length;
    printOutput(lines > SNAPSHOT_HINT_LINES ? `${text}\n[${lines} lines; snapshot --grep <text> or snapshot <eN> shows less]` : text, all);
  },

  async wait(args) {
    const usage = 'Usage: wait <selector> | wait text <text> | wait request <url-part|glob> | wait load, with optional [seconds]; --gone for a selector or text';
    let tokens = (args || '').trim().split(/\s+/).filter(Boolean);
    const gone = tokens.includes('--gone');
    tokens = tokens.filter(t => t !== '--gone');
    let seconds = WAIT_DEFAULT;
    // A number last is the seconds, unless it is all there is to wait for: wait text 990.
    const onlyWhat = (tokens[0] === 'text' || tokens[0] === 'request') && tokens.length === 2;
    if (tokens.length > 1 && !onlyWhat && /^\d+$/.test(tokens[tokens.length - 1])) seconds = Number(tokens.pop());
    if (!tokens.length || seconds < 1 || seconds > WAIT_MAX) throw new Error(`${usage} (1-${WAIT_MAX})`);
    const timeout = seconds * 1000;
    // Said plainly, not as Playwright's call log.
    const plainly = message => error => { throw /Timeout \d+ms exceeded/.test(error.message) ? new Error(message) : error; };
    const kind = tokens[0];
    if (kind === 'load' && tokens.length === 1) {
      if (gone) throw new Error(usage);
      return waitForLoad(timeout);
    }
    if ((kind === 'text' || kind === 'request') && tokens.length > 1) {
      const what = tokens.slice(1).join(' ').replace(/^(["'])(.*)\1$/, '$2').replace(/\\"/g, '"');
      if (kind === 'request') {
        if (gone) throw new Error(usage);
        return waitForRequest(what, timeout);
      }
      if (gone) return waitGone(state.page.getByText(what), what, timeout);
      await state.page.getByText(what).first().waitFor({ state: 'visible', timeout }).catch(plainly(`No visible text matches ${what} within ${seconds}s`));
      out.log(`Visible: ${what}`);
      return;
    }
    const selector = toSelector(unquote(tokens.join(' ')));
    if (gone) return waitGone(state.page.locator(selector), tokens.join(' '), timeout);
    await state.page.waitForSelector(selector, { state: 'visible', timeout }).catch(plainly(`No visible element matches ${tokens.join(' ')} within ${seconds}s`));
    out.log(`Visible: ${tokens.join(' ')}`);
  },

  async sleep(args) {
    if (!args || !/^\d+$/.test(args) || Number(args) > 3600000) throw new Error('Usage: sleep <ms> (maximum 3600000)');
    await state.page.waitForTimeout(Number(args));
    // sleep 3 is easily meant as seconds.
    out.log(Number(args) < 100 ? `Slept ${args}ms (sleep takes milliseconds: sleep ${args}000 is ${args}s)` : `Slept ${args}ms`);
  },

  async eval(args, all) {
    if (!args) throw new Error('Usage: eval <js-expression>');
    // eval <function> <ref> calls the function with that element, as playwright-cli's eval does.
    const onRef = /^([\s\S]+?)\s+((?:f\d+)?e\d+)$/.exec(args.trim());
    if (onRef && isFunctionText(unquote(onRef[1]))) {
      const selector = toSelector(onRef[2]);
      const el = await onElement(selector, () => state.page.locator(selector).first().elementHandle({ timeout: 5000 }));
      try {
        // Made from its text by the debugger, as eval is, so a page's CSP cannot
        // refuse it, and in the element's own frame, which may be an iframe.
        const fn = await withTimeout((await el.ownerFrame()).evaluateHandle(unquote(onRef[1])), 'Page evaluation', COMMAND_TIMEOUT);
        try {
          printOutput(await el.evaluate((e, f) => f(e), fn), all);
        } finally {
          await fn.dispose().catch(() => {});
        }
      } finally {
        await el.dispose().catch(() => {});
      }
      return;
    }
    // A function, as playwright-cli's eval takes, is called rather than returned.
    // Only a single expression can be one; statements are evaluated as they are.
    // await at the top level: one expression is run as an async function; statements as DevTools'
    // console runs them (replMode), which gives back the last one's value.
    const compiles = (Kind, body) => { try { new Kind(body); return true; } catch { return false; } };
    const AsyncFunction = (async () => {}).constructor;
    const awaits = /\bawait\b/.test(args) && !compiles(Function, `return (${args}\n);`);
    const single = compiles(awaits ? AsyncFunction : Function, `return (${args}\n);`);
    const call = `const value = (${args}\n); return typeof value === 'function' ? value() : value;`;
    if (awaits && !single && compiles(AsyncFunction, args)) {
      const session = await keptSession(state.page);
      const { result, exceptionDetails } = await withTimeout(session.send('Runtime.evaluate', { expression: args, replMode: true, awaitPromise: true, returnByValue: true }), 'Page evaluation', COMMAND_TIMEOUT);
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      printOutput(result.value !== undefined ? result.value : result.description ?? 'undefined', all);
      return;
    }
    const expression = single ? `(${awaits ? 'async ' : ''}() => { ${call} })()` : args;
    const value = await withTimeout(state.page.evaluate(expression), 'Page evaluation', COMMAND_TIMEOUT);
    // An empty string is shown as one, not as no output at all.
    printOutput(value === '' ? '""' : value, all);
  },

  async cdp(args, all) {
    const match = /^(\S+)\s+([\s\S]+)$/.exec(args || '');
    if (!match) throw new Error('Usage: cdp <method> <JSON object>');
    if (['Browser.close', 'Target.closeTarget'].includes(match[1])) throw new Error('Browser lifecycle commands are reserved; use quit or tab close.');
    if (match[1] === 'Page.handleJavaScriptDialog') throw new Error(CDP_REFUSED);
    const params = JSON.parse(match[2]);
    if (!params || Array.isArray(params) || typeof params !== 'object') throw new Error('Parameters must be a JSON object');
    const operation = async () => {
      const cdp = await state.page.context().newCDPSession(state.page);
      try {
        return await cdp.send(match[1], params);
      } finally {
        await cdp.detach().catch(() => {});
      }
    };
    printOutput(await withTimeout(operation(), 'CDP operation', COMMAND_TIMEOUT), all);
  },

  async cookies(_args, all) {
    const cookies = await state.page.context().cookies();
    if (!cookies.length) { out.log('No cookies'); return; }
    printOutput(cookies.map(({ name, domain, path, expires, httpOnly, secure, sameSite }) =>
      ({ name, domain, path, expires, httpOnly, secure, sameSite })), all);
  },

  async storage(_args, all) {
    const keys = await state.page.evaluate(() =>
      Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    );
    if (!keys.length) { out.log('localStorage is empty'); return; }
    printOutput(keys, all);
  },
};

module.exports = { commands, compactSnapshot, grepSnapshot };
