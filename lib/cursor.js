// A pointer drawn over the page, for videos: the REPL's input moves no pointer on screen. With it on,
// the commands that act on an element or at a point glide it there first and then act, and a
// click shows where it landed. It shows the REPL's own input only: the user's pointer is theirs.
// The REPL moves it, not the page's own mouse events, which the user's mouse fires as well.
const { state, onShutdown } = require('./state');
const out = require('./output');
const { tabState } = require('./tabstate');
const { unquote, toSelector } = require('./syntax');
const { recordingOf, stepTarget, cursorStep } = require('./record');
const { inOverlay, keepAcrossPages, forget } = require('./overlay');

// Scaled with the distance, so a short hop is quick and a long one does not drag. Slower while the tab
// records, so a viewer can follow it.
const DWELL_MS = 300;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const glideTime = (distance, recording) => {
  if (distance < 2) return 0;
  const [min, max, base, perPixel] = recording ? [300, 1000, 200, 0.8] : [150, 600, 100, 0.5];
  return Math.round(Math.min(max, Math.max(min, base + distance * perPixel)));
};

// Runs in the page, as the overlay's cursor layer (lib/overlay.js).
function pageCursor(overlay, { x, y, action, ms, count, fade, box, items, index }) {
  const { set } = overlay;
  const place = (el, px, py) => set(el, { transform: `translate(${px}px, ${py}px)` });
  let cursor = overlay.cursor;
  if (action === 'remove') {
    if (!cursor) return;
    delete overlay.cursor;
    if (!fade) { overlay.drop('cursor'); return; }
    // Waited on, as a glide is, but not past its time in a tab that draws no frames.
    const fading = cursor.arrow.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
    return Promise.race([fading.finished, new Promise(resolve => setTimeout(resolve, 500))]).then(() => overlay.drop('cursor'), () => overlay.drop('cursor'));
  }
  if (!cursor || !overlay.has('cursor')) {
    const root = overlay.layer('cursor');
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
    cursor = overlay.cursor = { root, arrow, x, y };
    place(arrow, x, y);
    // Faded in when turned on; drawn again on a new page, it is there at once, as it was.
    if (fade) arrow.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
  }
  if (action === 'move') {
    const from = `translate(${cursor.x}px, ${cursor.y}px)`;
    const to = `translate(${x}px, ${y}px)`;
    cursor.x = x;
    cursor.y = y;
    place(cursor.arrow, x, y);
    if (!ms) return;
    // Smoothstep, exactly (x = t with these control points, and y = 3t² - 2t³), so a tool editing the
    // video can work out from the steps file where the cursor is on every frame.
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

// Glides the tab's cursor to a point, if it is on, and waits for it to get there.
async function glideTo(p, x, y) {
  const cursor = cursorOf(p);
  if (!cursor) return;
  const ms = glideTime(Math.hypot(x - cursor.x, y - cursor.y), !!recordingOf(p));
  // A recording with --steps notes where the pointer went and when, for whoever edits the video.
  if (ms) cursorStep(p, `(cursor from ${cursor.x} ${cursor.y})`, { x, y }, ms);
  cursor.x = x;
  cursor.y = y;
  await inOverlay(p, pageCursor, { x, y, action: 'move', ms }).catch(() => {});
}

// Whether a command should find its element first: to glide the cursor there, or, while recording, to
// scroll to it smoothly and note it in the steps (record on --steps).
function aiming(p) {
  return !!(cursorOf(p) || recordingOf(p));
}

// While recording, an element out of view is scrolled to smoothly, to the middle, rather than jumped to
// as Playwright's own scroll would. The page scrolls itself, so no input is sent and a scrollable box
// it is in scrolls too. One larger than the view is scrolled to only if its centre, where Playwright
// acts, is out of view. Done when it has held still for a few frames: a nested box ends its scroll on
// its own, and nothing ends one that never started.
async function scrollSmoothly(target) {
  // Chrome slows a background tab's timers too, so the REPL bounds the wait as well.
  await Promise.race([sleep(2000), target.evaluate(async (el, cap) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const inView = r.width > innerWidth || r.height > innerHeight
      ? cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight
      : r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    if (inView) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    // A tab that is not drawing (behind another, minimised) has no frames: the timer keeps the cap.
    const frame = () => new Promise(resolve => { requestAnimationFrame(resolve); setTimeout(resolve, 100); });
    const started = performance.now();
    const from = `${r.left},${r.top}`;
    let last = from;
    let still = 0;
    // A smooth scroll can take a frame or two to start: longer to wait while nothing has moved yet.
    while (performance.now() - started < cap && still < (last === from ? 10 : 3)) {
      await frame();
      const b = el.getBoundingClientRect();
      const at = `${b.left},${b.top}`;
      still = at === last ? still + 1 : 0;
      last = at;
    }
  }, 1500).catch(() => {})]);
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
    if (recordingOf(p)) await scrollSmoothly(target);
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
  await inOverlay(p, pageCursor, { x: cursor.x, y: cursor.y, action: 'click', count }).catch(() => {});
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
  const opened = await inOverlay(p, pageCursor, { action: 'pickerOpen', box, items: before.items, index: before.index }).catch(() => null);
  if (!opened) return act();
  await sleep(350 * pace);
  await glideTo(p, Math.round(cursor.x), Math.round(opened.rowY + before.chosen * opened.rowHeight));
  await inOverlay(p, pageCursor, { action: 'pickerChoose', index: before.chosen }).catch(() => {});
  await showClick(p);
  try {
    return await act();
  } finally {
    await sleep(250 * pace);
    await inOverlay(p, pageCursor, { action: 'pickerClose' }).catch(() => {});
  }
}

async function cursorOff(p) {
  if (!cursorOf(p)) return false;
  const { x, y } = cursorOf(p);
  delete tabState(p).cursor;
  cursorStep(p, '(cursor off)', { x, y }, 0);
  forget(p, 'cursor');
  await inOverlay(p, pageCursor, { action: 'remove', fade: true }, false).catch(() => {});
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
        await target.waitFor({ state: 'visible', timeout: 5000 });
      } catch {
        throw new Error(`No element matches ${where} that can be shown (waited 5s); ${still}`);
      }
      // Only pointing: an element partly in view is pointed at where it shows, not scrolled, so that
      // one the page cuts off still looks cut off (a bug in a video). One wholly out of view is scrolled to.
      const view = await p.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const inView = b => b && b.x < view.width && b.y < view.height && b.x + b.width > 0 && b.y + b.height > 0;
      let box = await target.boundingBox();
      if (!inView(box)) {
        await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        box = await target.boundingBox();
      }
      if (!box) throw new Error(`${where} is not on the page to show the cursor at; ${still}`);
      const left = Math.max(box.x, 0);
      const top = Math.max(box.y, 0);
      const right = Math.min(box.x + box.width, view.width);
      const bottom = Math.min(box.y + box.height, view.height);
      at = { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
    } else {
      at = tabState(p).mouseAt || await p.evaluate(() => ({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) }));
    }
    // Already on: the drawing glides there, and the real mouse stays put, as with fill.
    if (cursor) {
      await glideTo(p, at.x, at.y);
      out.log(`The cursor moved to ${at.x}, ${at.y}`);
      return;
    }
    await inOverlay(p, pageCursor, { x: at.x, y: at.y, action: 'draw', fade: true });
    tabState(p).cursor = { owner: state.client, x: at.x, y: at.y };
    cursorStep(p, '(cursor on)', at, 0);
    // A new document drops it: it is drawn again where it was.
    keepAcrossPages(p, 'cursor', async () => { const c = cursorOf(p); if (c) await inOverlay(p, pageCursor, { x: c.x, y: c.y, action: 'draw' }); });
    out.log(`The cursor is on, at ${at.x}, ${at.y}: commands on elements and the mouse glide it there first, and clicks show where they land; cursor off hides it`);
  },
};

module.exports = { commands, cursorOf, cursorOff, aiming, aimAt, glideTo, showClick, showSelect };
