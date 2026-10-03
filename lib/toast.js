// A line of text over the page, to narrate a video or a screenshot: it stays until toast off, or for
// --duration. One per tab; another replaces it.
const { state, onShutdown } = require('./state');
const out = require('./output');
const { tabState } = require('./tabstate');
const { unquote } = require('./syntax');
const { takeOptions } = require('./cli-names');
const { inOverlay, keepAcrossPages, forget } = require('./overlay');
const { recordingOf, beforeRecordingEnds } = require('./record');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// While the tab records, a toast stays up at least this long (its read time) before another, toast off
// or record off may take it down: about the pace captions are read at.
const READ_MS_PER_WORD = 300;
const READ_MS_MIN = 1500;
const LONG_READ_MS = 15000;
const DEFAULTS = { position: 'bottom', size: 24, align: 'center', color: '#fff', background: 'rgba(20, 20, 20, .85)', opacity: 1 };

// Runs in the page, as the overlay's toast layer (lib/overlay.js). A new toast waits for the old one to
// fade out, then fades in; both are waited on, but not past their time in a tab that draws no frames.
function pageToast(overlay, { text, style, action, fade }) {
  const { set } = overlay;
  const old = overlay.toast;
  const fadeTo = (el, from, to) => Promise.race([
    el.animate([{ opacity: from }, { opacity: to }], { duration: 200, fill: 'forwards' }).finished,
    new Promise(resolve => setTimeout(resolve, 500)),
  ]).catch(() => {});
  if (action === 'remove') {
    if (!old) return;
    delete overlay.toast;
    return (fade ? fadeTo(old, getComputedStyle(old).opacity, 0) : Promise.resolve()).then(() => {
      old.remove();
      if (!overlay.toast) overlay.drop('toast');
    });
  }
  const box = document.createElement('div');
  overlay.toast = box;
  box.textContent = text;
  const edge = { top: { top: '6%' }, center: { top: '50%' }, bottom: { bottom: '6%' } }[style.position];
  set(box, {
    position: 'absolute', left: '50%', ...edge, transform: `translate(-50%, ${style.position === 'center' ? '-50%' : '0'})`,
    'max-width': '80%', width: 'max-content', 'box-sizing': 'border-box', padding: `${Math.round(style.size * 0.5)}px ${Math.round(style.size * 0.9)}px`,
    'border-radius': `${Math.round(style.size * 0.45)}px`, background: style.background, color: style.color, opacity: String(style.opacity),
    font: `500 ${style.size}px/1.35 system-ui, -apple-system, 'Segoe UI', sans-serif`, 'text-align': style.align,
    'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere', 'box-shadow': '0 4px 18px rgba(0, 0, 0, .3)',
  });
  const out = old && fade ? fadeTo(old, getComputedStyle(old).opacity, 0) : Promise.resolve();
  return out.then(() => {
    old?.remove();
    if (overlay.toast !== box) return;
    overlay.layer('toast').append(box);
    if (fade) return fadeTo(box, 0, style.opacity);
  });
}

function toastOf(p) {
  return tabState(p).toast || null;
}

// Waits out what is left of the toast's read time, while its tab records; says so, when it waited.
async function waitToRead(p) {
  const toast = toastOf(p);
  if (!toast || !toast.readMs || !recordingOf(p)) return;
  const left = toast.shownAt + toast.readMs - Date.now();
  if (left <= 0) return;
  await sleep(left);
  out.log(`Waited ${(left / 1000).toFixed(1)}s for the toast's read time (the tab is recording)`);
}

async function toastOff(p, fade = true) {
  const toast = toastOf(p);
  if (!toast) return false;
  clearTimeout(toast.timer);
  delete tabState(p).toast;
  forget(p, 'toast');
  await inOverlay(p, pageToast, { action: 'remove', fade }, false).catch(() => {});
  return true;
}

beforeRecordingEnds(p => (p && !p.isClosed() ? waitToRead(p) : null));

// 3s, 1.5s, 800ms, or a number of milliseconds.
function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(value || '');
  if (!match) return null;
  return Math.round(Number(match[1]) * (match[2] === 's' ? 1000 : 1));
}

onShutdown(async () => {
  if (!state.browser || state.connectionLost) return;
  const pages = state.browser.contexts().flatMap(c => c.pages()).filter(p => !p.isClosed());
  await Promise.all(pages.map(p => toastOff(p, false).catch(() => {})));
});

const commands = {
  async toast(args) {
    const p = state.page;
    const line = (args || '').trim();
    const toast = toastOf(p);
    if (!line) {
      out.log(toast
        ? `A toast is up in the selected tab${toast.owner ? ` (by ${toast.owner})` : ''}: ${JSON.stringify(toast.text)}${toast.until ? `, for ${Math.max(0, Math.round((toast.until - Date.now()) / 100) / 10)}s more` : ''}; toast off hides it`
        : 'No toast is up in the selected tab; toast <text> shows one');
      return;
    }
    if (line === 'off') {
      await waitToRead(p);
      out.log(await toastOff(p) ? 'The toast is gone' : 'No toast was up in the selected tab');
      return;
    }
    const usage = 'Usage: toast <text> [--duration=<time>] [--read-time=<time>] [--position=top|center|bottom] [--size=<px>] [--align=left|center|right] [--color=<css>] [--background=<css>] [--opacity=<0-1>] | toast off';
    const { found, rest } = takeOptions(line, { duration: 'value', 'read-time': 'value', position: 'value', size: 'value', align: 'value', color: 'value', background: 'value', opacity: 'value' });
    const text = unquote(rest.trim());
    if (!text) throw new Error(usage);
    const style = { ...DEFAULTS };
    let duration = null;
    let readTime = null;
    for (const { name, value } of found) {
      if (value === undefined || value === '') throw new Error(`--${name} needs a value: ${usage}`);
      if (name === 'duration') {
        duration = parseDuration(value);
        if (!duration) throw new Error(`--duration is a time, e.g. --duration=3s or --duration=1500 (ms): ${usage}`);
      } else if (name === 'read-time') {
        readTime = parseDuration(value);
        if (readTime === null) throw new Error(`--read-time is a time, e.g. --read-time=4s, or 0 for none: ${usage}`);
      } else if (name === 'position') {
        if (!['top', 'center', 'bottom'].includes(value)) throw new Error(`--position is top, center or bottom: ${usage}`);
        style.position = value;
      } else if (name === 'align') {
        if (!['left', 'center', 'right'].includes(value)) throw new Error(`--align is left, center or right: ${usage}`);
        style.align = value;
      } else if (name === 'size') {
        const size = Number(String(value).replace(/px$/, ''));
        if (!(size >= 8 && size <= 200)) throw new Error(`--size is the text's size in pixels, 8 to 200: ${usage}`);
        style.size = size;
      } else if (name === 'opacity') {
        const opacity = Number(value);
        if (!(opacity > 0 && opacity <= 1)) throw new Error(`--opacity is above 0, up to 1: ${usage}`);
        style.opacity = opacity;
      } else {
        style[name] = value;
      }
    }
    if (duration && readTime !== null) throw new Error(`--duration and --read-time do not go together: a toast with a --duration ends by itself, and nothing waits for it`);
    // Replaced, not stacked: the old one fades out, then the new one fades in.
    if (toast) {
      await waitToRead(p);
      clearTimeout(toast.timer);
    }
    const words = text.split(/\s+/).filter(Boolean).length;
    const readMs = duration ? 0 : readTime ?? Math.max(READ_MS_MIN, words * READ_MS_PER_WORD);
    const shown = tabState(p).toast = { owner: state.client, text, style, until: duration ? Date.now() + duration : null, readMs, shownAt: Date.now() };
    await inOverlay(p, pageToast, { text, style, action: 'draw', fade: true });
    shown.shownAt = Date.now();
    keepAcrossPages(p, 'toast', async () => { if (toastOf(p) === shown) await inOverlay(p, pageToast, { text, style, action: 'draw', fade: false }); });
    if (duration) shown.timer = setTimeout(() => { if (toastOf(p) === shown && !p.isClosed()) toastOff(p).catch(() => {}); }, duration);
    if (duration) { out.log(`Showing the toast for ${duration / 1000}s`); return; }
    const why = readTime !== null ? '--read-time' : `${words} word${words === 1 ? '' : 's'}; ${READ_MS_PER_WORD}ms a word, at least ${READ_MS_MIN / 1000}s`;
    // Past send's default 20s, the command that waits would come back unconfirmed while it still waits.
    const long = readMs > LONG_READ_MS ? ` While recording, that one can wait up to ${readMs / 1000}s: send it with -t ${Math.ceil(readMs / 1000) + 10}.` : '';
    out.log(`Showing the toast until toast off. ${readMs ? `Read time: ${readMs / 1000}s (${why}), which a recording waits out before the next toast, toast off or record off.${long}` : 'No read time (--read-time=0).'}`);
  },
};

module.exports = { commands, toastOf, toastOff };
