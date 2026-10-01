// A pointer drawn over the page, for videos: the REPL's input moves no pointer on screen. With it on,
// the commands that act on an element or at a point glide it there first and then act, and a
// click shows where it landed. It shows the REPL's own input only: the user's pointer is theirs.
// The REPL moves it, not the page's own mouse events, which the user's mouse fires as well.
const { state, onShutdown } = require('./state');
const out = require('./output');
const { tabState } = require('./tabstate');
const { unquote, toSelector } = require('./syntax');
const { recordingOf, stepsOf, stepTarget, cursorStep } = require('./record');

// Scaled with the distance, so a short hop is quick and a long one does not drag. Slower while the tab
// records, so a video (and a zoom that follows the cursor) can be followed.
const DWELL_MS = 300;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const glideTime = (distance, recording) => {
  if (distance < 2) return 0;
  const [min, max, base, perPixel] = recording ? [300, 1000, 200, 0.8] : [150, 600, 100, 0.5];
  return Math.round(Math.min(max, Math.max(min, base + distance * perPixel)));
};

// Runs in the page. Its own element under <html>, not <body>, which frameworks replace, with a closed
// shadow root, so the page's selectors, the snapshot and text do not find what is in it. It takes no
// pointer events, so what is under it is clicked, and it is built with the DOM and inline styles,
// which a page's Trusted Types or style-src rules do not block. It is shown as a popover, in the top
// layer, above the page's own dialogs, as Playwright's highlight is. Kept on the document under a
// symbol, so each call finds it again, and one the page removed is drawn again.
function pageCursor({ x, y, action, ms, count, fade, box, items, index }) {
  const KEY = Symbol.for('pw-repl-cursor');
  // Important on the element in the page, whose own rules could reach it; inside, the page's cannot,
  // and an important transform would win over the glide's animation.
  const set = (el, styles, important = '') => { for (const [name, value] of Object.entries(styles)) el.style.setProperty(name, value, important); };
  const place = (el, px, py) => set(el, { transform: `translate(${px}px, ${py}px)` });
  let cursor = document[KEY];
  if (action === 'remove') {
    if (!cursor) return;
    delete document[KEY];
    if (!fade || !cursor.host.isConnected) { cursor.host.remove(); return; }
    // Waited on, as a glide is, but not past its time in a tab that draws no frames.
    const fading = cursor.arrow.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
    return Promise.race([fading.finished, new Promise(resolve => setTimeout(resolve, 500))]).then(() => cursor.host.remove(), () => cursor.host.remove());
  }
  if (!cursor || !cursor.host.isConnected) {
    const host = document.createElement('pw-repl-cursor');
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('popover', 'manual');
    set(host, {
      display: 'block', position: 'fixed', inset: '0', width: '100%', height: '100%', 'max-width': 'none',
      'max-height': 'none', margin: '0', padding: '0', border: 'none', background: 'transparent',
      overflow: 'visible', 'pointer-events': 'none', 'z-index': '2147483647',
    }, 'important');
    const root = host.attachShadow({ mode: 'closed' });
    const NS = 'http://www.w3.org/2000/svg';
    const arrow = document.createElementNS(NS, 'svg');
    arrow.setAttribute('width', '20');
    arrow.setAttribute('height', '28');
    arrow.setAttribute('viewBox', '0 0 15 21');
    set(arrow, { position: 'absolute', left: '0', top: '0', overflow: 'visible', filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.4))' });
    const shape = document.createElementNS(NS, 'path');
    // The tip at 0,0 is the point.
    shape.setAttribute('d', 'M0 0 L0 17 L4.2 13.2 L7 19.6 L9.8 18.4 L7.1 12.1 L12.6 12.1 Z');
    shape.setAttribute('fill', '#111');
    shape.setAttribute('stroke', '#fff');
    shape.setAttribute('stroke-width', '1.4');
    shape.setAttribute('stroke-linejoin', 'round');
    arrow.append(shape);
    root.append(arrow);
    document.documentElement.append(host);
    cursor = document[KEY] = { host, root, arrow, x, y };
    place(arrow, x, y);
    // Faded in when turned on; drawn again on a new page, it is there at once, as it was.
    if (fade) arrow.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
  }
  // Shown again, so it is above a dialog the page opened since.
  try { cursor.host.hidePopover(); cursor.host.showPopover(); } catch {}
  if (action === 'move') {
    const from = `translate(${cursor.x}px, ${cursor.y}px)`;
    const to = `translate(${x}px, ${y}px)`;
    cursor.x = x;
    cursor.y = y;
    place(cursor.arrow, x, y);
    if (!ms) return;
    // Smoothstep, exactly (x = t with these control points, and y = 3t² - 2t³): the easing a zoom that
    // follows the cursor uses, so it knows where the cursor is on every frame.
    const glide = cursor.arrow.animate([{ transform: from }, { transform: to }], { duration: ms, easing: 'cubic-bezier(0.3333, 0, 0.6667, 1)' });
    // A hidden tab draws no frames, and its animation may never finish: not waited on past its time.
    return Promise.race([glide.finished, new Promise(resolve => setTimeout(resolve, ms + 300))]).then(() => {}, () => {});
  }
  // A select's list, drawn under it: a native one opens outside the page, where no recording sees it.
  if (action === 'pickerOpen') {
    cursor.picker?.remove();
    const list = document.createElement('div');
    const rowHeight = 28;
    set(list, {
      position: 'absolute', left: `${box.x}px`, top: `${box.y + box.height + 2}px`, 'min-width': `${Math.max(box.width, 120)}px`,
      background: '#fff', border: '1px solid #9aa0a6', 'border-radius': '4px', 'box-shadow': '0 4px 14px rgba(0,0,0,.25)',
      font: '15px system-ui, sans-serif', color: '#202124', padding: '4px 0', 'box-sizing': 'border-box', overflow: 'hidden',
    });
    const rows = items.slice(0, 10).map(text => {
      const row = document.createElement('div');
      row.textContent = text;
      set(row, { height: `${rowHeight}px`, 'line-height': `${rowHeight}px`, padding: '0 12px', 'white-space': 'nowrap' });
      list.append(row);
      return row;
    });
    cursor.picker = list;
    cursor.pickerRows = rows;
    cursor.root.insertBefore(list, cursor.arrow);
    const mark = i => rows.forEach((row, j) => set(row, { background: j === i ? '#1a73e8' : 'transparent', color: j === i ? '#fff' : '#202124' }));
    cursor.pickerMark = mark;
    mark(index);
    list.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 150 });
    // Where the chosen row will be, for the cursor to go to.
    return { rowY: box.y + box.height + 2 + 4 + rowHeight / 2, rowHeight };
  }
  if (action === 'pickerChoose') {
    cursor.pickerMark?.(index);
    return;
  }
  if (action === 'pickerClose') {
    const list = cursor.picker;
    if (!list) return;
    cursor.picker = null;
    return Promise.race([list.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: 'forwards' }).finished, new Promise(resolve => setTimeout(resolve, 400))])
      .then(() => list.remove(), () => list.remove());
  }
  if (action === 'click') {
    // A ring that grows and fades where the click landed, one for each click of a double-click.
    for (let i = 0; i < count; i += 1) {
      const ring = document.createElement('div');
      set(ring, {
        position: 'absolute', left: `${x - 14}px`, top: `${y - 14}px`, width: '28px', height: '28px', 'box-sizing': 'border-box',
        'border-radius': '50%', border: '2px solid rgba(230, 40, 40, .9)', background: 'rgba(230, 40, 40, .3)', opacity: '0',
      });
      cursor.root.insertBefore(ring, cursor.arrow);
      ring.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.5)', opacity: 0 }], { duration: 450, delay: i * 140, easing: 'ease-out' })
        .finished.then(() => ring.remove(), () => ring.remove());
    }
  }
}

function cursorOf(p) {
  return tabState(p).cursor || null;
}

// A new document drops the cursor: it is drawn again where it was.
function keepAcrossPages(p) {
  if (tabState(p).cursorKept) return;
  tabState(p).cursorKept = true;
  p.on('domcontentloaded', () => {
    const cursor = cursorOf(p);
    if (cursor) p.evaluate(pageCursor, { x: cursor.x, y: cursor.y, action: 'draw' }).catch(() => {});
  });
}

// Glides the tab's cursor to a point, if it is on, and waits for it to get there.
async function glideTo(p, x, y) {
  const cursor = cursorOf(p);
  if (!cursor) return;
  const ms = glideTime(Math.hypot(x - cursor.x, y - cursor.y), !!recordingOf(p));
  // A recording notes where the pointer went and when, for a zoom to follow it.
  if (ms) cursorStep(p, `(cursor from ${cursor.x} ${cursor.y})`, { x, y }, ms);
  cursor.x = x;
  cursor.y = y;
  await p.evaluate(pageCursor, { x, y, action: 'move', ms }).catch(() => {});
}

// Whether a command should find its element first: to glide the cursor there, or to note it in a
// recording's steps.
function aiming(p) {
  return !!(cursorOf(p) || stepsOf(p));
}

// Finds the centre of an element (a locator or a handle), where Playwright clicks, after scrolling it
// into view as Playwright would, and glides the cursor there if it is on: the pointer is there before
// the click, not after. A recording notes the element in its steps.
// It waits for a locator's element to be there, as the command would, and throws Playwright's timeout
// if none comes, for the command to report as its own: the command does not wait all over again. One
// there but hidden (a file input under its button) is not glided to, and the command says why.
async function aimAt(p, target, timeout) {
  if (!aiming(p)) return null;
  if (target.waitFor) await target.waitFor({ state: 'attached', timeout });
  try {
    if (!await target.isVisible()) return null;
    await target.scrollIntoViewIfNeeded({ timeout: 2000 });
    const box = await target.boundingBox({ timeout: 1000 });
    if (!box) return null;
    const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    stepTarget(p, box, point);
    await glideTo(p, point.x, point.y);
    // While recording, a moment on the element before acting on it, for the viewer to see where it is.
    if (cursorOf(p) && recordingOf(p)) await sleep(DWELL_MS);
    return point;
  } catch {
    return null;
  }
}

// Shows a click where the cursor is; the input has landed by then. A click that loads a new page
// may take the ring with it.
async function showClick(p, count = 1) {
  const cursor = cursorOf(p);
  if (!cursor) return;
  await p.evaluate(pageCursor, { x: cursor.x, y: cursor.y, action: 'click', count }).catch(() => {});
}

// select with the cursor on: a native select's list opens outside the page, where no recording (or
// headless Chrome) shows it, so its list is drawn over the page instead. It opens under the select with
// the current option marked, the mark moves to the option to be chosen (by value or label, as
// Playwright's selectOption matches it), the cursor clicks it and the choice is made (act), and the list
// closes. Drawn only: the page gets the same input as without the cursor.
async function showSelect(p, target, value, act) {
  const cursor = cursorOf(p);
  const box = cursor && await target.boundingBox().catch(() => null);
  // Not drawn for a disabled select or option, which selectOption refuses: the video would show a choice
  // that was never made.
  const before = box && await target.evaluate((el, v) => {
    if (el.tagName !== 'SELECT' || el.multiple || el.size > 1 || el.disabled) return null;
    const chosen = [...el.options].findIndex(o => o.value === v || o.label === v);
    if (chosen >= 0 && (el.options[chosen].disabled || el.options[chosen].parentElement.disabled)) return null;
    return { items: [...el.options].map(o => o.label || o.text), index: el.selectedIndex, chosen };
  }, value).catch(() => null);
  if (!before || before.chosen < 0 || before.chosen >= 10) return act();
  const pace = recordingOf(p) ? 1 : 0.5;
  await showClick(p);
  const opened = await p.evaluate(pageCursor, { action: 'pickerOpen', box, items: before.items, index: before.index }).catch(() => null);
  if (!opened) return act();
  await sleep(350 * pace);
  await glideTo(p, Math.round(cursor.x), Math.round(opened.rowY + before.chosen * opened.rowHeight));
  await p.evaluate(pageCursor, { action: 'pickerChoose', index: before.chosen }).catch(() => {});
  await showClick(p);
  try {
    return await act();
  } finally {
    await sleep(250 * pace);
    await p.evaluate(pageCursor, { action: 'pickerClose' }).catch(() => {});
  }
}

async function cursorOff(p) {
  if (!cursorOf(p)) return false;
  const { x, y } = cursorOf(p);
  delete tabState(p).cursor;
  cursorStep(p, '(cursor off)', { x, y }, 0);
  await p.evaluate(pageCursor, { action: 'remove', fade: true }).catch(() => {});
  return true;
}

onShutdown(async () => {
  if (!state.browser || state.connectionLost) return;
  const pages = state.browser.contexts().flatMap(c => c.pages()).filter(p => !p.isClosed());
  await Promise.all(pages.map(p => cursorOff(p).catch(() => {})));
});

const commands = {
  async cursor(args) {
    const arg = (args || '').trim();
    const p = state.page;
    const cursor = cursorOf(p);
    if (!arg) {
      out.log(cursor
        ? `The cursor is on in the selected tab, at ${cursor.x}, ${cursor.y}${cursor.owner ? ` (by ${cursor.owner})` : ''}; cursor off hides it`
        : 'The cursor is off in the selected tab; cursor on shows it');
      return;
    }
    if (arg === 'off') {
      out.log(await cursorOff(p) ? 'The cursor is off' : 'The cursor was not on in the selected tab');
      return;
    }
    const usage = 'Usage: cursor [on [<selector> | <x> <y>] | off]';
    const on = /^on(?:\s+([\s\S]+))?$/.exec(arg);
    if (!on) throw new Error(usage);
    // Where it is asked to appear (a video's first element, say), or where the mouse last went, if the
    // REPL knows; otherwise the middle of the viewport.
    const where = (on[1] || '').trim();
    if (cursor && !where) { out.log(`The cursor is already on in the selected tab, at ${cursor.x}, ${cursor.y}; cursor on <selector> or <x> <y> moves it`); return; }
    const still = cursor ? 'the cursor stays where it was' : 'the cursor is still off';
    let at;
    if (/^-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?$/.test(where)) {
      const [x, y] = where.split(/\s+/).map(n => Math.round(Number(n)));
      at = { x, y };
    } else if (where) {
      const target = p.locator(toSelector(unquote(where))).first();
      try {
        await target.scrollIntoViewIfNeeded({ timeout: 5000 });
      } catch {
        throw new Error(`No element matches ${where} that can be shown (waited 5s); ${still}`);
      }
      const box = await target.boundingBox();
      if (!box) throw new Error(`${where} is not on the page to show the cursor at; ${still}`);
      at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    } else {
      at = tabState(p).mouseAt || await p.evaluate(() => ({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) }));
    }
    // Already on: the drawing glides there, and the real mouse stays put, as with fill.
    if (cursor) {
      await glideTo(p, at.x, at.y);
      out.log(`The cursor moved to ${at.x}, ${at.y}`);
      return;
    }
    await p.evaluate(pageCursor, { x: at.x, y: at.y, action: 'draw', fade: true });
    tabState(p).cursor = { owner: state.client, x: at.x, y: at.y };
    cursorStep(p, '(cursor on)', at, 0);
    keepAcrossPages(p);
    out.log(`The cursor is on, at ${at.x}, ${at.y}: commands on elements and the mouse glide it there first, and clicks show where they land; cursor off hides it`);
  },
};

module.exports = { commands, cursorOf, cursorOff, aiming, aimAt, glideTo, showClick, showSelect };
