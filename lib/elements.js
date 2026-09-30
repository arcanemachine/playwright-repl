// Elements and the mouse: finding the match to act on, and the commands that click, type and choose.
const path = require('path');
const fs = require('fs');
const { state, onShutdown } = require('./state');
const out = require('./output');
const { takeOptions } = require('./cli-names');
const { unquote, toSelector, keyName, splitSelector, REF } = require('./syntax');
const { numbers, hints } = require('./util');
const { tabState } = require('./tabstate');
const { cursorOf, aiming, aimAt, glideTo, showClick, showSelect } = require('./cursor');
const { recordingOf, stepTarget } = require('./record');

// The type a page sees for a file it is given, from its extension.
const MIME_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html',
  xml: 'application/xml', zip: 'application/zip', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  wav: 'audio/wav', doc: 'application/msword', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function mimeType(file) {
  return MIME_TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
}

// Commands that take only a selector take the whole line, spaces and all.
function soleSelector(args, usage) {
  const text = unquote((args || '').trim());
  if (!text) throw new Error(`Usage: ${usage}`);
  return toSelector(text);
}

const MODIFIERS = ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'];

// click <selector> [button] [--modifiers=<keys>], as playwright-cli's click
// takes them. The button is read only after a ref or a quoted selector, so
// click text=Turn right is still one selector.
function clickArgs(args, usage) {
  // Found outside quotes only, so a quoted selector keeps whatever is in it.
  const { found, rest: text } = takeOptions((args || '').trim(), { modifiers: 'value' });
  const modifiers = found.flatMap(o => (o.value || '').split(',').filter(Boolean).map(keyName));
  const unknown = modifiers.find(m => !MODIFIERS.includes(m));
  if (unknown) throw new Error(`Not a modifier: ${unknown}; they are ${MODIFIERS.join(', ')}`);
  const parsed = splitSelector(text);
  const button = parsed && /^(?:left|right|middle)$/.test(parsed.rest || '') && (REF.test(parsed.word) || /^["']/.test(text)) ? parsed.rest : null;
  const selector = button ? parsed.selector : soleSelector(text, usage);
  const options = { ...(button ? { button } : {}), ...(modifiers.length ? { modifiers } : {}) };
  return { selector, shown: args.trim(), options };
}

// A trailing --submit, as playwright-cli's fill and type take: Enter afterwards.
function submitFlag(args) {
  if (/(?:^|\s)--submit\s/.test((args || '').trim())) throw new Error('--submit goes at the end of the line');
  const match = /^([\s\S]*?)\s+--submit$/.exec((args || '').trim());
  return match ? { args: match[1], submit: true } : { args, submit: false };
}

function selectorAndValue(args, usage, example) {
  const parsed = splitSelector(args);
  if (!parsed || parsed.rest === undefined) {
    throw new Error(`Usage: ${usage}, e.g. ${example}; quote a selector with spaces: "text=Your name"`);
  }
  return { selector: parsed.selector, value: unquote(parsed.rest), shown: parsed.word };
}

// An element that never appeared is said plainly, not as Playwright's call
// log, and so is one that timed out: its call log (dozens of lines of retries) goes
// to the REPL's pane and log only. A ref that no longer matches usually means the page
// changed since the snapshot it came from.
async function onElement(selector, action) {
  try {
    return await action();
  } catch (error) {
    const message = String(error.message || '').replace(/\x1b\[[0-9;]*m/g, '');
    if (/strict mode violation/.test(message)) throw error;
    const ref = selector.startsWith('aria-ref=') ? selector.slice(9) : null;
    const staleRef = ref ? `\n${ref} is a snapshot ref; if the page changed since that snapshot, take a new one.` : '';
    const timeout = /Timeout (\d+)ms exceeded/.exec(message);
    if (timeout && /waiting for locator/.test(message) && !/resolved to/.test(message)) {
      throw new Error(`No element matches ${ref || selector} (waited ${timeout[1] / 1000}s)${staleRef}`);
    }
    if (!timeout) { error.message += staleRef; throw error; }
    console.error(`Playwright's call log:\n${message}`);
    // Found, so the ref is not stale: no hint.
    const summary = new Error(`Timed out after ${timeout[1] / 1000}s on ${ref || selector}: ${lastBlocker(message)} (its call log is in the REPL's pane or log)`);
    // Worked out from the whole log: the summary no longer says whether the element was found.
    summary.uncertain = !/waiting for locator/.test(message) || /resolved to/.test(message);
    throw summary;
  }
}

// What last stopped the action, from Playwright's call log: the element that took the click,
// or the check the element kept failing.
function lastBlocker(log) {
  const lines = log.split('\n').map(line => line.trim().replace(/^-\s*/, ''));
  const line = lines.reverse().find(l => /intercepts pointer events|element is not |element is outside|not attached|detached/.test(l));
  if (!line) return 'it never became ready to act on';
  return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}

// Where a match stands for a click: hidden elements are left out before this. Tested in
// its own frame, at its centre, and only when that is in view: scrolling each one to test
// it would move a page someone may be looking at.
function hitTest(el) {
  if (window !== window.top) return { kind: 'unchecked' };
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { kind: 'unchecked' };
  let top = document.elementFromPoint(x, y);
  while (top?.shadowRoot) {
    const inner = top.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === top) break;
    top = inner;
  }
  for (let n = top; n; n = n.parentNode || n.host) if (n === el) return { kind: 'hit' };
  const name = e => {
    const classes = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    return `<${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${classes.map(c => `.${c}`).join('')}>`;
  };
  return { kind: 'covered', by: top ? name(top) : 'nothing (off the page)' };
}

// Playwright acts on the first match and retries it until it times out, even when that one is
// hidden or under an overlay and a later one could be used. With several matches, this picks
// the first visible one that is not covered (or not checkable here, which Playwright then
// checks as it acts), waiting for one as Playwright waits; with none it fails before acting,
// saying why. The chosen element's handle is what is acted on, so the list changing
// meanwhile cannot shift the choice. Null: a ref or a single match, left to Playwright.
async function chooseMatch(selector, timeout) {
  if (selector.startsWith('aria-ref=')) return null;
  const locator = state.page.locator(selector);
  if (await locator.count() <= 1) return null;
  const deadline = Date.now() + timeout;
  let seen = { count: 0, handles: [], results: [] };
  for (;;) {
    const count = await locator.count();
    if (count <= 1 && !seen.handles.length) return null;
    const handles = await locator.filter({ visible: true }).elementHandles();
    const results = await Promise.all(handles.map(h => h.evaluate(hitTest).catch(() => ({ kind: 'gone' }))));
    // In page order: a later match in view must not win over an earlier one Playwright can scroll to.
    const index = results.findIndex(r => r.kind === 'hit' || r.kind === 'unchecked');
    if (index !== -1) {
      await Promise.all(seen.handles.concat(handles.filter((_, i) => i !== index)).map(h => h.dispose().catch(() => {})));
      const all = await locator.elementHandles();
      const position = (await Promise.all(all.map(h => h.evaluate((a, b) => a === b, handles[index])))).indexOf(true);
      await Promise.all(all.map(h => h.dispose().catch(() => {})));
      return { handle: handles[index], position: position + 1, count };
    }
    await Promise.all(seen.handles.map(h => h.dispose().catch(() => {})));
    seen = { count, handles, results };
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const listed = await Promise.all(seen.handles.slice(0, 5).map(async (h, i) => {
    const text = await h.evaluate(el => `<${el.tagName.toLowerCase()}> ${(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)}`).catch(() => '(gone)');
    const r = seen.results[i];
    return `  ${text}: ${r.kind === 'covered' ? `covered by ${r.by}` : 'gone from the page'}`;
  }));
  await Promise.all(seen.handles.map(h => h.dispose().catch(() => {})));
  const hidden = seen.count - seen.handles.length;
  const error = new Error([
    `None of the ${seen.count} matches for ${selector} could be acted on after ${timeout / 1000}s, so nothing was done:`,
    ...listed,
    ...(seen.handles.length > 5 ? [`  and ${seen.handles.length - 5} more like these`] : []),
    ...(hidden ? [`  ${hidden} hidden`] : []),
    'A more specific selector, or a ref from snapshot, picks one; covered ones may be under a dialog or overlay.',
  ].join('\n'));
  error.uncertain = false;
  throw error;
}

function mouseButton(args, name) {
  const button = (args || '').trim() || 'left';
  if (!/^(?:left|right|middle)$/.test(button)) throw new Error(`Usage: ${name} [left|right|middle]`);
  return button;
}

// click, dblclick and hover: on the match chooseMatch picks, or as Playwright does.
// A page that renders the chosen element again (as React lists do) replaces it before it is
// acted on; it is chosen again then, as Playwright finds a locator's element again.
async function pointerAction(selector, act, options = {}, clicks = 0) {
  const TIMEOUT = 5000;
  const deadline = Date.now() + TIMEOUT;
  const left = () => Math.max(1000, deadline - Date.now());
  for (;;) {
    const chosen = await onElement(selector, () => chooseMatch(selector, left()));
    if (!chosen) {
      // Only counted so far, so the whole time is Playwright's, as it was before; the cursor's glide, if it
      // is on, waits for the element as part of it.
      const glided = Date.now();
      const point = await onElement(selector, () => aimAt(state.page, state.page.locator(selector).first(), TIMEOUT));
      await onElement(selector, () => act(state.page, selector, { ...options, timeout: Math.max(1000, TIMEOUT - (Date.now() - glided)) }));
      await landed(point, clicks);
      return '';
    }
    try {
      const point = await aimAt(state.page, chosen.handle, left());
      await onElement(selector, () => act(chosen.handle, null, { ...options, timeout: left() }));
      await landed(point, clicks);
      return chosen.position === 1 ? '' : ` (match ${chosen.position} of ${chosen.count}; the ones before it are hidden or covered)`;
    } catch (error) {
      if (!/not attached/i.test(error.message) || Date.now() >= deadline) throw error;
    } finally {
      await chosen.handle.dispose().catch(() => {});
    }
  }
}

// After a pointer action: Playwright's mouse is where it acted, at the centre the cursor glided to,
// or somewhere the REPL does not know without the cursor. A click shows where it landed.
async function landed(point, clicks) {
  tabState(state.page).mouseAt = point;
  if (clicks) await showClick(state.page, clicks);
}

// Finds the element a command without a pointer acts on (fill, select...), for the cursor to glide
// to, as someone would go to it first, and for a recording's steps; the mouse itself stays where it is. What is left of the command's
// 5s is its timeout, so the glide does not make it wait longer for an element that never comes.
async function aimFor(selector) {
  if (!aiming(state.page)) return 5000;
  const started = Date.now();
  await onElement(selector, () => aimAt(state.page, state.page.locator(selector).first(), 5000));
  return Math.max(1000, 5000 - (Date.now() - started));
}

// While the tab records, text is typed at a pace a viewer can follow, steady rather than human-like,
// and faster for long text, so it takes 8s at most: a paragraph at 60ms a key would outrun send's 20s
// default and hold every client's commands meanwhile. Otherwise at once, as before.
function typingPace(text) {
  if (!recordingOf(state.page) || !text.length) return 0;
  return Math.round(Math.min(60, 8000 / text.length));
}

// check, uncheck and upload's button click it at its centre, where aimFor put the cursor.
async function clickedHere() {
  const cursor = cursorOf(state.page);
  if (!cursor) return;
  tabState(state.page).mouseAt = { x: cursor.x, y: cursor.y };
  await showClick(state.page);
}

// The mouse commands act where the mouse is: the cursor goes back there first, if it went elsewhere.
async function glideToMouse() {
  const at = tabState(state.page).mouseAt;
  if (!at) return;
  stepTarget(state.page, null, at);
  await glideTo(state.page, at.x, at.y);
}

// Highlights: Playwright's own overlay, as playwright-cli's highlight draws it. Each is a mode of its
// tab, so modes shows it and modes off hides it, and none is left on the page when the REPL stops.
function highlightsOf(p) {
  if (!tabState(p).highlights) {
    tabState(p).highlights = new Map();
    // A new document drops the overlay; a page that routes on the client keeps it.
    p.on('domcontentloaded', () => tabState(p).highlights?.clear());
  }
  return tabState(p).highlights;
}

// Hides a tab's highlights, or only the running client's (mine).
async function hideHighlights(p, mine = false) {
  const highlights = tabState(p).highlights;
  if (!highlights?.size) return 0;
  const hidden = [...highlights].filter(([, h]) => !mine || (h.owner ?? null) === (state.client ?? null));
  if (hidden.length === highlights.size) await p.hideHighlight();
  else for (const [selector] of hidden) await p.locator(selector).hideHighlight();
  for (const [selector] of hidden) highlights.delete(selector);
  return hidden.length;
}

onShutdown(async () => {
  if (!state.browser || state.connectionLost) return;
  const pages = state.browser.contexts().flatMap(c => c.pages()).filter(p => !p.isClosed());
  await Promise.all(pages.map(p => hideHighlights(p).catch(() => {})));
});

const commands = {
  async click(args) {
    const { selector, shown, options } = clickArgs(args, 'click <selector> [left|right|middle] [--modifiers=<key>[,<key>]]');
    const which = await pointerAction(selector, (on, sel, o) => (sel ? on.click(sel, o) : on.click(o)), options, 1);
    out.log(`Clicked: ${shown}${which}`);
  },

  async dblclick(args) {
    const { selector, shown, options } = clickArgs(args, 'dblclick <selector> [left|right|middle] [--modifiers=<key>[,<key>]]');
    const which = await pointerAction(selector, (on, sel, o) => (sel ? on.dblclick(sel, o) : on.dblclick(o)), options, 2);
    out.log(`Double-clicked: ${shown}${which}`);
  },

  async hover(args) {
    const selector = soleSelector(args, 'hover <selector>');
    const which = await pointerAction(selector, (on, sel, o) => (sel ? on.hover(sel, o) : on.hover(o)));
    out.log(`Hovered: ${args.trim()}${which}`);
  },

  async highlight(args) {
    const usage = 'Usage: highlight [<selector> [--style=<css>] | --hide [<selector>] | off]';
    const { found, rest } = takeOptions((args || '').trim(), { style: 'value', hide: 'flag' });
    const style = found.find(o => o.name === 'style');
    const hide = found.some(o => o.name === 'hide');
    const highlights = highlightsOf(state.page);
    if (!rest && !found.length) {
      if (!highlights.size) { out.log(`Nothing is highlighted in the selected tab.\n${hints([['highlight <selector>', 'draw a box around it']])}`); return; }
      for (const [selector, h] of highlights) out.log(`${selector}${h.style ? `  --style=${JSON.stringify(h.style)}` : ''}${h.owner ? `  (by ${h.owner})` : ''}`);
      out.log(hints([['highlight --hide [<selector>]', 'hide one, or all']]));
      return;
    }
    if (rest === 'off' && !found.length || hide && !rest) {
      const count = await hideHighlights(state.page);
      out.log(count ? `Hid ${count} highlight${count === 1 ? '' : 's'}` : 'Nothing was highlighted in the selected tab.');
      return;
    }
    if (!rest || style && (hide || !style.value)) throw new Error(usage);
    const selector = soleSelector(rest, usage);
    const locator = state.page.locator(selector);
    if (hide) {
      if (!highlights.has(selector)) throw new Error(`${rest} is not highlighted; highlight lists what is`);
      await locator.hideHighlight();
      highlights.delete(selector);
      out.log(`Hid the highlight on ${rest}`);
      return;
    }
    const count = await locator.count();
    if (!count) throw new Error(`No element matches ${rest}; nothing was highlighted`);
    // Drawn again, with its new style, rather than twice.
    if (highlights.has(selector)) await locator.hideHighlight();
    await locator.highlight(style ? { style: style.value } : {});
    highlights.set(selector, { owner: state.client, style: style?.value || null });
    out.log(`Highlighted ${rest}${count > 1 ? ` (all ${count} matches)` : ''}; highlight --hide ${rest} hides it`);
  },

  // At a point, in CSS pixels from the top left of the tab's viewport, as playwright-cli's are.
  async mousemove(args) {
    const [x, y, extra] = numbers(args, 'mousemove <x> <y>');
    if (y === undefined || extra !== undefined) throw new Error('Usage: mousemove <x> <y>, in CSS pixels from the top left of the viewport');
    stepTarget(state.page, null, { x, y });
    await glideTo(state.page, x, y);
    await state.page.mouse.move(x, y);
    tabState(state.page).mouseAt = { x, y };
    out.log(`Moved the mouse to ${x}, ${y}`);
  },

  async mousedown(args) {
    const button = mouseButton(args, 'mousedown');
    await glideToMouse();
    await state.page.mouse.down({ button });
    await showClick(state.page);
    out.log(`Pressed the ${button} button`);
  },

  async mouseup(args) {
    const button = mouseButton(args, 'mouseup');
    await glideToMouse();
    await state.page.mouse.up({ button });
    out.log(`Released the ${button} button`);
  },

  // Wheel events where the mouse is (mousemove puts it there): a map zooms around that point.
  async mousewheel(args) {
    const [dx, dy, extra] = numbers(args, 'mousewheel <dx> <dy>');
    if (dy === undefined || extra !== undefined) throw new Error('Usage: mousewheel <dx> <dy>, e.g. mousewheel 0 300 scrolls down (negative dy up)');
    await glideToMouse();
    await state.page.mouse.wheel(dx, dy);
    out.log(`Turned the wheel by ${dx}, ${dy}`);
  },

  async fill(line) {
    const { args, submit } = submitFlag(line);
    const { selector, value, shown } = selectorAndValue(args, 'fill <selector> <value> [--submit]', 'fill #name Ada Lovelace');
    const timeout = await aimFor(selector);
    await onElement(selector, () => state.page.fill(selector, value, { timeout }));
    if (submit) await state.page.press(selector, 'Enter', { timeout: 5000 });
    out.log(`Filled${submit ? ' and submitted' : ''}: ${shown}`);
  },

  async type(line) {
    // --delay=<ms> goes first, so text with --delay in it is still text.
    const paced = /^\s*--delay(?:=|\s+)(\S*)(?:\s+|$)/.exec(line || '');
    if (paced && !/^\d+$/.test(paced[1])) throw new Error('Usage: type --delay=<ms> [<selector>] <text>, the pause between keys, e.g. type --delay=80 #search garden hose');
    const { args, submit } = submitFlag(paced ? line.slice(paced[0].length) : line);
    const delay = text => (paced ? Number(paced[1]) : typingPace(text));
    // One word, or one quoted, is typed into the focused element, as playwright-cli's type does.
    const sole = splitSelector(args);
    if (sole && sole.rest === undefined) {
      // Named, since it may not be the element meant; one that takes no text is refused.
      const focused = await state.page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        const editable = el.isContentEditable || el.matches('textarea, input:not([type=checkbox],[type=radio],[type=button],[type=submit],[type=reset],[type=image],[type=file],[type=range],[type=color],[type=hidden])');
        const id = el.id ? `#${el.id}` : el.name ? `[name=${el.name}]` : el.placeholder ? `[placeholder="${el.placeholder}"]` : '';
        return { editable, name: `${el.tagName.toLowerCase()}${id}` };
      });
      const usage = 'type <selector> <text> types into an element, e.g. type #search garden hose';
      if (!focused) throw new Error(`Nothing on the page has focus: ${usage}`);
      if (!focused.editable) throw new Error(`The focused element, ${focused.name}, takes no text: ${usage}`);
      await state.page.keyboard.type(sole.word, { delay: delay(sole.word) });
      if (submit) await state.page.keyboard.press('Enter');
      out.log(`Typed into the focused ${focused.name}${submit ? ', and submitted' : ''}`);
      return;
    }
    const { selector, value, shown } = selectorAndValue(args, 'type [<selector>] <text> [--submit]', 'type #search garden hose');
    const timeout = await aimFor(selector);
    // Typed after what the field already holds, as someone clicking into it
    // at the end would; focusing it alone leaves the caret at the start.
    await onElement(selector, () => state.page.locator(selector).first().evaluate(el => {
      el.focus();
      if (typeof el.value === 'string' && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
      } else if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
    }, null, { timeout }));
    await state.page.keyboard.type(value, { delay: delay(value) });
    if (submit) await state.page.keyboard.press('Enter');
    out.log(`Typed into${submit ? ' and submitted' : ''}: ${shown}`);
  },

  async press(args) {
    const parsed = splitSelector(args);
    if (!parsed) throw new Error('Usage: press <key> | press <selector> <key>, e.g. press Enter or press #name Enter');
    if (parsed.rest === undefined) {
      await state.page.keyboard.press(keyName(parsed.word));
      out.log(`Pressed: ${keyName(parsed.word)}`);
      return;
    }
    const key = keyName(unquote(parsed.rest));
    const timeout = await aimFor(parsed.selector);
    await onElement(parsed.selector, () => state.page.press(parsed.selector, key, { timeout }));
    out.log(`Pressed ${key} on ${parsed.word}`);
  },

  async select(args) {
    const { selector, value, shown } = selectorAndValue(args, 'select <selector> <value>', 'select #country Canada');
    const timeout = await aimFor(selector);
    const target = state.page.locator(selector).first();
    await onElement(selector, () => showSelect(state.page, target, value, () => state.page.selectOption(selector, value, { timeout })));
    out.log(`Selected "${value}" in ${shown}`);
  },

  async check(args) {
    const selector = soleSelector(args, 'check <selector>');
    const timeout = await aimFor(selector);
    await onElement(selector, () => state.page.check(selector, { timeout }));
    await clickedHere();
    out.log(`Checked: ${args.trim()}`);
  },

  async uncheck(args) {
    const selector = soleSelector(args, 'uncheck <selector>');
    const timeout = await aimFor(selector);
    await onElement(selector, () => state.page.uncheck(selector, { timeout }));
    await clickedHere();
    out.log(`Unchecked: ${args.trim()}`);
  },

  // The files are read here and handed to the page as their contents, not
  // their paths: the browser may run on another machine, or in another
  // container, where the paths mean nothing.
  async upload(args) {
    const parsed = splitSelector(args);
    // playwright-cli's upload <file> answers a file picker a click opened. Here
    // the input is named instead: catching pickers would catch the person's too.
    const usage = 'Usage: upload <selector> <file>..., naming the file input (or the button that opens it) first, e.g. upload e12 ./doc.pdf; quote a path with spaces';
    if (!parsed || parsed.rest === undefined) throw new Error(usage);
    // A path, not a selector; // starts an XPath.
    if (/^(?:\.{1,2}\/|\/(?!\/)|~)/.test(parsed.word) || (!REF.test(parsed.word) && fs.statSync(path.resolve(parsed.word), { throwIfNoEntry: false })?.isFile())) throw new Error(`${parsed.word} is a file, not the input: ${usage.slice(7)}`);
    const files = [...parsed.rest.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(m => path.resolve(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]));
    const payloads = files.map(file => {
      let buffer;
      try { buffer = fs.readFileSync(file); } catch (error) { throw new Error(`Cannot read ${file}: ${error.code === 'ENOENT' ? 'no such file' : error.code === 'EISDIR' ? 'it is a folder' : error.message}`); }
      return { name: path.basename(file), mimeType: mimeType(file), buffer };
    });
    const { selector } = parsed;
    await aimFor(selector);
    await onElement(selector, async () => {
      try {
        await state.page.setInputFiles(selector, payloads, { timeout: 5000 });
      } catch (error) {
        if (!/not an HTMLInputElement/.test(error.message)) throw error;
        // A button that opens the file picker itself: click it, and answer the picker.
        const [chooser] = await Promise.all([state.page.waitForEvent('filechooser', { timeout: 5000 }), state.page.click(selector, { timeout: 5000 })]);
        await chooser.setFiles(payloads);
        await clickedHere();
      }
    });
    out.log(`Chose ${files.length === 1 ? 'a file' : `${files.length} files`} in ${parsed.word}: ${files.join(', ')}`);
  },
};

module.exports = { commands, soleSelector, onElement, hideHighlights };
