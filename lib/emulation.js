// Emulating a phone, a color scheme, a locale or a timezone in a tab, and its viewport.
const { state, onShutdown } = require('./state');
const out = require('./output');
const { devices } = require('playwright-core');
const { hints } = require('./util');
const { tabState } = require('./tabstate');
const { keptSession } = require('./cdp');

// A tab in a browser the REPL connected to has no viewport set, so its size is
// the window's; it is read from the page.
async function viewportText() {
  const device = tabState(state.page).emulation?.device;
  if (device) {
    const { width, height } = devices[device].viewport;
    // A page with no viewport meta tag is laid out as on a desktop, and the phone shows it shrunk.
    const laidOut = await state.page.evaluate(() => innerWidth).catch(() => null);
    const wider = laidOut && laidOut > width ? `; the page lays out ${laidOut} wide, shown shrunk: it has no viewport meta tag` : '';
    return `${width}x${height} (emulate mobile: ${device}${wider})`;
  }
  const set = tabState(state.page).viewport;
  if (set) return `${set.width}x${set.height} (set with viewport)`;
  const size = await state.page.evaluate(() => `${innerWidth}x${innerHeight}`).catch(() => null);
  return size ? `${size} (the window's size)` : 'unknown';
}

const DEFAULT_DEVICE = 'Pixel 7';
const EMULATE_KINDS = ['mobile', 'dark', 'light', 'locale', 'timezone'];

function emulatedKinds(e) {
  return [e?.device && 'mobile', e?.scheme, e?.locale && 'locale', e?.timezone && 'timezone'].filter(Boolean);
}

const DEVICES_SHOWN = 20;

function deviceNamed(name) {
  const names = Object.keys(devices);
  const found = names.find(d => d.toLowerCase() === name.toLowerCase());
  if (found) return found;
  // The names that have every word typed, so a near miss finds the exact name.
  const words = name.toLowerCase().split(/\s+/);
  const close = names.filter(d => !/ landscape$/.test(d) && words.every(w => d.toLowerCase().includes(w)));
  if (!close.length) throw new Error(`No device ${JSON.stringify(name)}; names are Playwright's, e.g. Pixel 7, iPhone 13, iPad Mini, Galaxy S9+`);
  const more = close.length > DEVICES_SHOWN ? `, and ${close.length - DEVICES_SHOWN} more` : '';
  throw new Error(`No device ${JSON.stringify(name)}; matching: ${close.slice(0, DEVICES_SHOWN).join(', ')}${more} (each also as "<name> landscape")`);
}

function deviceText(name) {
  const d = devices[name];
  return `${name}, ${d.viewport.width}x${d.viewport.height} at ${d.deviceScaleFactor}x${d.hasTouch ? ', touch' : ''}`;
}

// A viewport set with viewport, on the kept session, as a phone's size is, so that viewport off can
// undo it: Playwright's setViewportSize has no undo. As Playwright sets it, at one device pixel per
// CSS pixel, and the window is left as it is.
function viewportMetrics(session, { width, height }) {
  return session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
}

// Chrome answers a change of screen size before the page has it (a clear, often), so the size read
// next, a screenshot or a recording would be the old one: two frames later it has it. Bounded, as a
// dialog holds the page.
function settled(p) {
  return Promise.race([
    p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ]);
}

// Bringing a tab to the front can leave Chrome capturing it at the window's size after its next
// navigation, although the page is still laid out at its viewport's or phone's: sending the same
// metrics again, on the kept session, has it draw at them.
async function reapplyMetrics(p) {
  const tab = tabState(p);
  if (!tab.viewport && !tab.emulation?.device) return;
  const session = await keptSession(p);
  if (tab.viewport) await viewportMetrics(session, tab.viewport);
  else if (tab.emulation?.device) await deviceMetrics(session, tab.emulation.device);
  await settled(p);
}

async function setViewport(p, size) {
  const session = await keptSession(p);
  if (size) {
    await viewportMetrics(session, size);
    tabState(p).viewport = { ...size, owner: state.client };
  } else {
    await session.send('Emulation.clearDeviceMetricsOverride');
    delete tabState(p).viewport;
  }
  await settled(p);
}

// Sends only what changed. Chrome takes the user agent and the languages
// together, so a change to either sends both.
function deviceMetrics(session, name) {
  const d = devices[name];
  return session.send('Emulation.setDeviceMetricsOverride', {
    width: d.viewport.width, height: d.viewport.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.isMobile,
    screenWidth: d.screen?.width || d.viewport.width, screenHeight: d.screen?.height || d.viewport.height,
  });
}

async function setEmulation(p, next) {
  const session = await keptSession(p);
  const previous = tabState(p).emulation || {};
  const send = (method, params) => session.send(method, params);
  if (next.device !== previous.device) {
    const d = devices[next.device];
    if (d) {
      await deviceMetrics(session, next.device);
    } else {
      await send('Emulation.clearDeviceMetricsOverride');
    }
    await send('Emulation.setTouchEmulationEnabled', d?.hasTouch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await settled(p);
  }
  if (next.device !== previous.device || next.locale !== previous.locale) {
    if (next.device || next.locale) {
      const userAgent = next.device ? devices[next.device].userAgent : (await send('Browser.getVersion')).userAgent;
      await send('Emulation.setUserAgentOverride', { userAgent, ...(next.locale ? { acceptLanguage: next.locale } : {}) });
    } else {
      // An empty user agent ends the override.
      await send('Emulation.setUserAgentOverride', { userAgent: '' });
    }
  }
  if (next.locale !== previous.locale) await send('Emulation.setLocaleOverride', next.locale ? { locale: next.locale } : {});
  if (next.timezone !== previous.timezone) await send('Emulation.setTimezoneOverride', { timezoneId: next.timezone || '' });
  if (next.scheme !== previous.scheme) await send('Emulation.setEmulatedMedia', { features: next.scheme ? [{ name: 'prefers-color-scheme', value: next.scheme }] : [] });
  if (emulatedKinds(next).length) tabState(p).emulation = { ...next, owner: state.client }; else delete tabState(p).emulation;
}

function showEmulation() {
  const e = tabState(state.page).emulation;
  const forms = [
    ['emulate mobile [device]', `a phone's screen, touch and user agent (default ${DEFAULT_DEVICE})`],
    ['emulate dark | light', 'the color scheme the page sees'],
    ['emulate locale <tag>', 'its language and formats, e.g. fr-FR'],
    ['emulate timezone <zone>', 'e.g. Asia/Tokyo'],
  ];
  if (!e) {
    out.log('Nothing is emulated in the selected tab.');
    out.log(hints(forms));
    return;
  }
  out.log('Emulated in the selected tab:');
  const rows = [
    e.device && ['mobile', deviceText(e.device)],
    e.scheme && ['color scheme', e.scheme],
    e.locale && ['locale', e.locale],
    e.timezone && ['timezone', e.timezone],
  ].filter(Boolean);
  for (const [what, value] of rows) out.log(`  ${what.padEnd(12)}  ${value}`);
  out.log(hints([...forms, ['emulate <what> off | emulate off', 'stop one, or all']]));
}

// Resets every tab's emulation and viewport, which detaching would only partly undo.
async function resetEmulations() {
  if (!state.browser || state.connectionLost) return;
  const pages = state.browser.contexts().flatMap(c => c.pages()).filter(p => !p.isClosed());
  await Promise.all(pages.map(async p => {
    if ('emulation' in tabState(p)) await setEmulation(p, {}).catch(() => {});
    if ('viewport' in tabState(p)) await setViewport(p, null).catch(() => {});
  }));
}

onShutdown(resetEmulations);

const commands = {
  async viewport(args) {
    const arg = (args || '').trim();
    if (!arg) { out.log(await viewportText()); return; }
    if (arg === 'off') {
      if (!tabState(state.page).viewport) { out.log(`No viewport is set in the selected tab: ${await viewportText()}`); return; }
      await setViewport(state.page, null);
      out.log(`Viewport off: ${await viewportText()}`);
      return;
    }
    const match = /^(\d+)x(\d+)$/.exec(arg);
    const [w, h] = match ? [Number(match[1]), Number(match[2])] : [];
    if (!w || !h) throw new Error('Usage: viewport [<width>x<height> | off]');
    // Both set the screen size; whichever came last would win without saying so.
    if (tabState(state.page).emulation?.device) throw new Error('emulate mobile sets the size of the selected tab; emulate mobile off first');
    await setViewport(state.page, { width: w, height: h });
    out.log(`Viewport set to ${w}x${h}`);
  },

  // Per tab, like network: the settings live in the tab's kept CDP session.
  async emulate(args) {
    const words = (args || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return showEmulation();
    const usage = 'Usage: emulate [mobile [device] | dark | light | locale <tag> | timezone <zone>], emulate <what> off, emulate off';
    const [what, ...rest] = words;
    const value = rest.join(' ');
    const current = tabState(state.page).emulation || {};
    if (what === 'off' && !rest.length) {
      const was = emulatedKinds(current);
      await setEmulation(state.page, {});
      out.log(was.length ? `Stopped emulating in the selected tab: ${was.join(', ')}` : 'Nothing was emulated in the selected tab.');
      return;
    }
    if (!EMULATE_KINDS.includes(what)) throw new Error(usage);
    const key = { mobile: 'device', dark: 'scheme', light: 'scheme', locale: 'locale', timezone: 'timezone' }[what];
    if (value === 'off') {
      await setEmulation(state.page, { ...current, [key]: undefined });
      out.log(`Stopped emulating ${key === 'scheme' ? 'the color scheme' : what} in the selected tab`);
      // As when turned on: the page keeps what it read at load until it loads again.
      if ((what === 'mobile' || what === 'locale') && state.page.url() !== 'about:blank') out.log('The page sees its own user agent, touch and languages again from its next load: reload to see all of it.');
      return;
    }
    let next;
    if (what === 'mobile') {
      // One screen size at a time, as viewport refuses while a phone's is set.
      if (tabState(state.page).viewport) throw new Error('viewport sets the size of the selected tab; viewport off first');
      next = deviceNamed(value || DEFAULT_DEVICE);
    } else if (what === 'dark' || what === 'light') {
      if (value) throw new Error(usage);
      next = what;
    } else if (!value || rest.length > 1) {
      throw new Error(`Usage: emulate ${what} ${what === 'locale' ? '<tag>, e.g. fr-FR' : '<zone>, e.g. Asia/Tokyo'}`);
    } else if (what === 'locale') {
      try { next = Intl.getCanonicalLocales(value)[0]; } catch { throw new Error(`Not a locale: ${value}; e.g. fr-FR, de, pt-BR`); }
    } else {
      // Checked, but kept as given: Node's names can be older ones (Asia/Calcutta for Asia/Kolkata).
      try { new Intl.DateTimeFormat('en-US', { timeZone: value }); } catch { throw new Error(`Not a timezone: ${value}; e.g. Asia/Tokyo, America/New_York, UTC`); }
      next = value;
    }
    await setEmulation(state.page, { ...current, [key]: next });
    const shown = what === 'mobile' ? `mobile (${deviceText(next)})` : what === 'dark' || what === 'light' ? `${what} mode` : `${what} ${next}`;
    out.log(`Emulating ${shown} in the selected tab`);
    // The page reads these when it loads; the rest applies at once. A blank tab has nothing to reload.
    if ((what === 'mobile' || what === 'locale') && state.page.url() !== 'about:blank') out.log('The page sees its user agent, touch and languages from its next load: reload to see all of it.');
  },
};

module.exports = { commands, viewportText, EMULATE_KINDS, emulatedKinds, deviceMetrics, viewportMetrics, setEmulation, setViewport, settled, reapplyMetrics };
