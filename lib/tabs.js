// Tabs: listing, selecting, opening and closing them, and navigating the selected one.
const { state } = require('./state');
const out = require('./output');
const { hints } = require('./util');
const { tabState } = require('./tabstate');
const { keepDrawing } = require('./cdp');
const { ensureDialogHandler } = require('./dialogs');
const { notLoaded, stayedPut } = require('./requestlog');
const { viewportText } = require('./emulation');
const { recordingOf, endedByTabClose } = require('./record');

// A navigation that does not load is said as wait load says it, from its request, rather than as
// Playwright's net:: error and call log.
async function navigating(go) {
  const started = Date.now();
  try {
    return await go();
  } catch (error) {
    if (!/net::ERR_/.test(error.message)) throw error;
    const find = () => (tabState(state.page).log || []).filter(e => e.navigation && e.t >= started && e.failed && e.status !== 'pending').pop();
    for (let waited = 0; !find() && waited < 1000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
    const navigation = find();
    if (!navigation) throw error;
    throw new Error(notLoaded(navigation));
  }
}

// A page restored from the back/forward cache never fires its load events
// again, so back and forward wait only for the navigation, then briefly for
// the document to be parsed, which a restored one already is.
async function historyStep(go, direction) {
  const before = state.page.url();
  const response = await navigating(go);
  if (response === null && state.page.url() === before) throw new Error(`No page to go ${direction} to`);
  await state.page.waitForFunction(() => document.readyState !== 'loading', null, { timeout: 3000 }).catch(() => {});
}

// The tab the REPL opened for its start URL, which tab marks: in a kept profile it sits among restored tabs.
function markStartTab(p) {
  tabState(p).start = true;
}

// A tab of the REPL's own: closing it can go back to the tab before. It opens
// in the background, so it does not take the front of the window from the
// user using the browser; Playwright's newPage would bring it to the front.
const OPEN_TIMEOUT = 10000;
const FRONT_READ_TIMEOUT = 500;

// True while tab new opens a tab: watch on --next-tab waits for one someone
// else opens, not one a client of the REPL opens for itself.
let opening = false;

function isOpening() {
  return opening;
}

async function openTab() {
  opening = true;
  try { return await openOwnTab(); } finally { opening = false; }
}

async function openOwnTab() {
  const ctx = state.browser.contexts()[0];
  let opened = null;
  const session = await state.browser.newBrowserCDPSession().catch(() => null);
  if (session) {
    try {
      const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', background: true });
      opened = await pageForTarget(ctx, targetId);
    } catch {} finally {
      await session.detach().catch(() => {});
    }
  }
  // A browser that cannot open one in the background (e.g. some headless ones) opens it as usual.
  if (!opened) opened = await ctx.newPage();
  tabState(opened).opened = true;
  tabState(opened).owner = state.client;
  await keepDrawing(opened);
  return opened;
}

// A page's CDP target id, asked for once per page.
async function targetIdOf(ctx, p) {
  if (!('targetId' in tabState(p))) {
    const cdp = await ctx.newCDPSession(p).catch(() => null);
    if (!cdp) return null;
    const info = await cdp.send('Target.getTargetInfo').catch(() => null);
    await cdp.detach().catch(() => {});
    if (!info) return null;
    tabState(p).targetId = info.targetInfo.targetId;
  }
  return tabState(p).targetId;
}

async function pageForTarget(ctx, targetId) {
  const deadline = Date.now() + OPEN_TIMEOUT;
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      if ('opened' in tabState(p)) continue;
      if (await targetIdOf(ctx, p) === targetId) return p;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

// Every tab, URL first, with * on the selected one. The numbers are what tab <index> uses.
// Whether a tab is the one in front in its window, as the tab itself says: 'visible', 'visible,
// focused' (its window has the keyboard, and not in the address bar), or null. Not for a tab a client
// uses, which is told it is in front so that it draws (lib/cdp.js); nor for one that does not answer
// at once (a dialog open, a frozen tab). Each window has one in front, an incognito one too.
async function inFront(p) {
  if (tabState(p).focusEmulated) return null;
  const read = p.evaluate(() => [document.visibilityState, document.hasFocus()]).catch(() => null);
  const seen = await Promise.race([read, new Promise(resolve => setTimeout(resolve, FRONT_READ_TIMEOUT, null))]);
  if (!seen || seen[0] !== 'visible') return null;
  return seen[1] ? 'visible, focused' : 'visible';
}

async function listTabs() {
  const all = state.browser.contexts().flatMap(c => c.pages());
  if (state.page && !all.includes(state.page)) state.page = null;
  state.tabListing = all.slice();
  if (!all.length) { out.log('No tabs. Use tab new.'); return; }
  const fronts = await Promise.all(all.map(inFront));
  for (const [i, p] of all.entries()) {
    let title;
    try { title = await p.title(); } catch { title = '[title unavailable]'; }
    const marker = p === state.page ? '*' : ' ';
    // URL first on its own line: it is what distinguishes otherwise
    // identically titled tabs, and titles wrap less badly when indented.
    if (i) out.log('');
    const notes = [fronts[i], 'start' in tabState(p) && 'the start URL', tabState(p).owner && `opened by ${tabState(p).owner}`].filter(Boolean);
    out.log(`${marker} [${i}] ${p.url()}${notes.length ? `  (${notes.join(', ')})` : ''}`);
    out.log(`        ${JSON.stringify(title)}`);
  }
}

const commands = {
  async tab(args) {
    const trimmed = (args || '').trim();
    if (!trimmed) {
      await listTabs();
      if (!state.page) out.log('\nNo tab is selected.');
      out.log(hints([
        ['tab <index|url-part>', 'select a tab'],
        ['tab new [url]', 'open a tab of your own and select it'],
        ['tab close [url-part]', 'close the selected tab, or the one whose URL contains url-part'],
      ]));
      return;
    }
    const usage = 'Usage: tab [<index> | <url-part> | new [url] | close [<url-part>]]';
    const parts = trimmed.split(/\s+/);
    const subcommand = parts.shift();
    const all = state.browser.contexts().flatMap(c => c.pages());
    // Matching on the URL, not an index, so a stale listing cannot point at someone else's tab.
    // Remembers where the REPL was, so closing a tab can go back there, but
    // only to a tab this REPL opened: the previous one may be someone else's.
    // Its focus is on before anything acts in it: a click in a tab that is not yet told it is focused
    // can leave it drawing a frame a second (lib/cdp.js).
    const select = async p => {
      if (p !== state.page) state.previousPage = state.page;
      state.page = p;
      ensureDialogHandler(p);
      await keepDrawing(p);
    };
    // Opened by this client, with tab new: the prompt's and nameless senders' are theirs together.
    const mine = p => 'opened' in tabState(p) && tabState(p).owner === state.client;
    const byUrl = part => {
      const matches = all.filter(p => p.url().includes(part));
      if (matches.length === 1) return matches[0];
      if (!matches.length) throw new Error(`No tab URL contains "${part}"`);
      throw new Error(`${matches.length} tabs match "${part}"; use a longer part:\n${matches.map(p => `  ${p.url()}${mine(p) ? '  (opened by you)' : ''}`).join('\n')}`);
    };
    if (/^\d+$/.test(subcommand)) {
      if (parts.length) throw new Error(usage);
      const target = state.tabListing[Number(subcommand)];
      if (target && all.includes(target)) { await select(target); return commands.info(); }
      // Not read as part of a URL instead: that could land in someone else's tab without a word.
      if (target) throw new Error(`Tab [${subcommand}] has closed since the latest listing. Run tab to list them again.`);
      // A number that is not a tab in the listing may be part of a URL (a port).
      const containing = all.filter(p => p.url().includes(subcommand)).length;
      if (!containing) throw new Error(`No tab [${subcommand}] in the latest listing, and no tab URL contains ${subcommand}. Run tab to list them.`);
      if (containing > 1) {
        const listing = state.tabListing.length ? 'the latest listing' : 'a listing yet: each client has its own, from tab';
        throw new Error(`No tab [${subcommand}] in ${listing}. As part of a URL, ${subcommand} is in ${containing} tabs. Run tab, then tab <index>.`);
      }
    }
    if (subcommand === 'new') {
      await select(await openTab());
      const url = parts.join(' ');
      if (url) {
        try { await commands.goto(url); }
        catch (error) { throw new Error(`${error.message}\nThe new tab stays open and selected; tab close closes it.`); }
      } else {
        out.log('New tab created and selected');
      }
      return listTabs();
    }
    if (subcommand === 'close') {
      const part = parts.join(' ');
      const matches = part ? all.filter(p => p.url().includes(part)) : [];
      // Of several, the one tab you opened is the one to close: the others may be someone else's.
      const yours = matches.length > 1 && matches.filter(mine).length === 1 ? matches.find(mine) : null;
      const target = yours || (part ? byUrl(part) : state.page);
      if (!target || target.isClosed() || !all.includes(target)) throw new Error('Selected tab is unavailable. Run tab again.');
      if (all.length <= 1) throw new Error('Refusing to close the last tab');
      const url = target.url();
      const wasSelected = target === state.page;
      const recording = recordingOf(target);
      await target.close();
      if (wasSelected) {
        const back = state.previousPage;
        state.page = back && !back.isClosed() && 'opened' in tabState(back) ? back : null;
        state.previousPage = null;
      }
      out.log(`Closed ${url}${yours ? `, the one you opened; ${matches.length - 1} other ${matches.length === 2 ? 'tab matches' : 'tabs match'} "${part}"` : ''}${wasSelected && !state.page ? '; no tab is selected now' : ''}`);
      if (recording) out.log(await endedByTabClose(recording));
      return listTabs();
    }
    await select(byUrl(trimmed));
    return commands.info();
  },

  async goto(args) {
    if (!args) throw new Error('Usage: goto <url>');
    let url = args;
    // As a browser's address bar does: a local dev server is almost always plain http.
    const local = /^(?:localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)(?:[:/?#]|$)/i.test(url);
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url) && !/^(about|data|file|javascript):/i.test(url)) url = `${local ? 'http' : 'https'}://${url}`;
    await navigating(() => state.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }));
    out.log(`${state.page.url()} — ${await state.page.title()}`);
  },

  async back() {
    await historyStep(() => state.page.goBack({ waitUntil: 'commit', timeout: 10000 }), 'back');
    out.log(`Back to: ${state.page.url()}`);
  },

  async forward() {
    await historyStep(() => state.page.goForward({ waitUntil: 'commit', timeout: 10000 }), 'forward');
    out.log(`Forward to: ${state.page.url()}`);
  },

  async reload() {
    await navigating(() => state.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }));
    out.log(`Reloaded: ${state.page.url()}`);
  },

  async info() {
    out.log(`  URL:   ${state.page.url()}`);
    // Chrome's error page has a URL of its own; the one that failed is in the request log.
    if (state.page.url().startsWith('chrome-error://')) {
      const failed = (tabState(state.page).log || []).filter(e => e.navigation && e.failed && !stayedPut(e)).pop();
      if (failed) out.log(`  Error: Chrome's error page, for #${failed.id} ${failed.url} ${failed.status}`);
    }
    out.log(`  Title: ${await state.page.title()}`);
    out.log(`  Viewport: ${await viewportText()}`);
  },
};

module.exports = { commands, markStartTab, isOpening, openTab, listTabs };
