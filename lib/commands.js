const { state, shutdown } = require('./state');
const out = require('./output');
const HELP = require('./help');
const { hints, clock } = require('./util');
const { tabState } = require('./tabstate');
const { keepDrawing } = require('./cdp');
const { commands: dialogsCommands, ensureDialogHandler, dialogCommand } = require('./dialogs');
const { commands: elementsCommands } = require('./elements');
const { commands: requestlogCommands, ensureRecentLog, notLoaded, stayedPut } = require('./requestlog');
const { commands: routesCommands, routesFor, unroute } = require('./routes');
const { commands: networkCommands, setNetwork } = require('./network');
const { commands: emulationCommands, viewportText, EMULATE_KINDS, emulatedKinds, setEmulation } = require('./emulation');
const { commands: captureCommands, currentCapture, endCapture } = require('./capture');
const { commands: inspectCommands, compactSnapshot, grepSnapshot } = require('./inspect');
const { commands: watchCommands, summarizeChanges, scrubEditable, nextTabWanted, stopWaitingForNextTab, waitingForMe, waitingText, watchNewTab, stopWatching } = require('./watch');


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

// The modes turned on in a tab, in the order the prompt shows them.
function activeModes(p) {
  const modes = [];
  if (tabState(p).watch?.on) modes.push('watch');
  const network = tabState(p).network;
  if (network) modes.push(network.offline ? 'network:off' : 'network:slow');
  const emulated = emulatedKinds(tabState(p).emulation);
  if (emulated.length) modes.push(`emulate:${emulated.join(',')}`);
  const routes = tabState(p).routes?.size;
  if (routes) modes.push(`routes:${routes}`);
  if (currentCapture()?.page === p) modes.push('capture');
  return modes;
}

function listModes() {
  const all = state.browser.contexts().flatMap(c => c.pages());
  state.tabListing = all.slice();
  const on = all.map((p, i) => [p, i, activeModes(p)]).filter(([, , modes]) => modes.length);
  const want = nextTabWanted();
  if (want) out.log(`${waitingText()} (watch off stops waiting)${want.client ? `, for ${want.client}` : ''}${on.length ? '\n' : ''}`);
  if (!on.length && want) return;
  if (!on.length) {
    out.log('No modes are on in any tab.');
    out.log(hints([
      ['watch on', 'record what the person at the browser does'],
      ['capture on', 'record requests and console messages together'],
      ['route <url-glob> <status> <json-body>', 'fake a response'],
      ['network off', 'cut the tab\'s network'],
      ['emulate mobile', 'show the tab as a phone would'],
    ]));
    return;
  }
  const width = Math.max(...on.map(([p, i]) => `[${i}] ${p.url()}`.length));
  for (const [p, i, modes] of on) {
    out.log(`${p === state.page ? '*' : ' '} ${`[${i}] ${p.url()}`.padEnd(width)}  (${modes.join(' ')})`);
    const owners = modeOwners(p);
    if (owners.some(([owner]) => owner)) out.log(`      on by ${ownersText(owners)}`);
  }
  out.log(hints([['modes off', 'turn them all off']]));
}

// Who turned on each mode in a tab: [client, what], client null for the prompt or an unnamed sender.
function modeOwners(p) {
  const owners = [];
  const watch = tabState(p).watch;
  if (watch?.on) owners.push([watch.owner ?? null, 'watch']);
  const network = tabState(p).network;
  if (network) owners.push([network.owner ?? null, network.offline ? 'network:off' : 'network:slow']);
  const emulated = tabState(p).emulation;
  if (emulated) owners.push([emulated.owner ?? null, 'emulate']);
  for (const [glob, route] of tabState(p).routes || []) owners.push([route.owner ?? null, `route ${glob}`]);
  const capture = currentCapture();
  if (capture?.page === p) owners.push([capture.owner ?? null, 'capture']);
  return owners;
}

function ownersText(owners) {
  const byOwner = new Map();
  for (const [owner, what] of owners) byOwner.set(owner, [...(byOwner.get(owner) || []), what]);
  return [...byOwner].map(([owner, whats]) => `${owner || 'unnamed'}: ${whats.join(', ')}`).join('; ');
}

// Turns off everything the REPL turned on, in every tab: nothing it leaves
// behind keeps acting on someone's browser. mine: only what the running client turned on.
async function allModesOff(mine = false) {
  const all = state.browser.contexts().flatMap(c => c.pages());
  const ours = owner => !mine || (owner ?? null) === state.client;
  let any = false;
  let failed = 0;
  const want = nextTabWanted();
  if (want && ours(want.client)) { stopWaitingForNextTab(); any = true; out.log('Stopped waiting to watch a new tab'); }
  // A tab that fails (e.g. it crashed) must not keep the others' modes on.
  for (const p of all) {
    const done = [];
    let problem = null;
    try {
      const watch = tabState(p).watch;
      if (watch?.on && ours(watch.owner)) { stopWatching(p, watch); done.push('watch off'); }
      const capture = currentCapture();
      if (capture?.page === p && ours(capture.owner)) { endCapture(); done.push('capture off (capture shows it)'); }
      const globs = [...(tabState(p).routes || [])].filter(([, route]) => ours(route.owner)).map(([glob]) => glob);
      if (globs.length) { await unroute(p, globs); done.push(`${globs.length} route${globs.length === 1 ? '' : 's'} removed`); }
      if ('network' in tabState(p) && ours(tabState(p).network.owner)) { await setNetwork(p, null); done.push('network on'); }
      if ('emulation' in tabState(p) && ours(tabState(p).emulation.owner)) { await setEmulation(p, {}); done.push('emulate off'); }
    } catch (error) {
      problem = error.message;
    }
    if (done.length) { any = true; out.log(`${p.url()}: ${done.join(', ')}`); }
    if (problem) { failed += 1; out.error(`${p.url()}: could not turn everything off: ${problem}`); }
  }
  if (failed) throw new Error(`Modes may still be on in ${failed} tab${failed === 1 ? '' : 's'}; modes lists them`);
  if (!any) out.log(mine ? 'None of your modes were on.' : 'No modes were on.');
}

// A tab of the REPL's own: closing it can go back to the tab before. It opens
// in the background, so it does not take the front of the window from the
// person using the browser; Playwright's newPage would bring it to the front.
const OPEN_TIMEOUT = 10000;

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
  keepDrawing(opened);
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
async function listTabs() {
  const all = state.browser.contexts().flatMap(c => c.pages());
  if (state.page && !all.includes(state.page)) state.page = null;
  state.tabListing = all.slice();
  if (!all.length) { out.log('No tabs. Use tab new.'); return; }
  for (const [i, p] of all.entries()) {
    let title;
    try { title = await p.title(); } catch { title = '[title unavailable]'; }
    const marker = p === state.page ? '*' : ' ';
    // URL first on its own line: it is what distinguishes otherwise
    // identically titled tabs, and titles wrap less badly when indented.
    if (i) out.log('');
    const notes = ['start' in tabState(p) && 'the start URL', tabState(p).owner && `opened by ${tabState(p).owner}`].filter(Boolean);
    out.log(`${marker} [${i}] ${p.url()}${notes.length ? `  (${notes.join(', ')})` : ''}`);
    out.log(`        ${JSON.stringify(title)}`);
  }
}

const commands = {
  ...watchCommands,
  ...inspectCommands,
  ...captureCommands,
  ...emulationCommands,
  ...networkCommands,
  ...routesCommands,
  ...requestlogCommands,
  ...elementsCommands,
  ...dialogsCommands,
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
    const select = p => {
      if (p !== state.page) state.previousPage = state.page;
      state.page = p;
      ensureDialogHandler(p);
      keepDrawing(p);
    };
    const byUrl = part => {
      const matches = all.filter(p => p.url().includes(part));
      if (matches.length === 1) return matches[0];
      if (!matches.length) throw new Error(`No tab URL contains "${part}"`);
      throw new Error(`${matches.length} tabs match "${part}"; use a longer part:\n${matches.map(p => `  ${p.url()}`).join('\n')}`);
    };
    if (/^\d+$/.test(subcommand)) {
      if (parts.length) throw new Error(usage);
      const target = state.tabListing[Number(subcommand)];
      if (target && all.includes(target)) { select(target); return commands.info(); }
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
      select(await openTab());
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
      const target = parts.length ? byUrl(parts.join(' ')) : state.page;
      if (!target || target.isClosed() || !all.includes(target)) throw new Error('Selected tab is unavailable. Run tab again.');
      if (all.length <= 1) throw new Error('Refusing to close the last tab');
      const url = target.url();
      const wasSelected = target === state.page;
      await target.close();
      if (wasSelected) {
        const back = state.previousPage;
        state.page = back && !back.isClosed() && 'opened' in tabState(back) ? back : null;
        state.previousPage = null;
      }
      out.log(`Closed ${url}${wasSelected && !state.page ? '; no tab is selected now' : ''}`);
      return listTabs();
    }
    select(byUrl(trimmed));
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

  async modes(args) {
    const arg = (args || '').trim();
    if (!arg) return listModes();
    if (arg !== 'off' && arg !== 'off --mine') throw new Error('Usage: modes [off [--mine]]');
    await allModesOff(arg === 'off --mine');
  },

  async help(args) {
    const topic = (args || '').trim();
    const text = HELP.render(topic);
    if (text === null) throw new Error(HELP.notFound(topic));
    out.log(text);
  },

  async quit() {
    out.log('Disconnecting...');
    await shutdown();
  }
};

// Run for playwright-cli's names (lib/cli-names.js) where no command here does the same.
const cliCommands = {
  // By index only: tab <number> falls back to a tab whose URL contains the number.
  // The index is into the sender's last listing, so a tab someone opened or
  // closed since cannot shift it onto another tab; with none yet, the tabs now.
  async 'tab-select'(args) {
    const all = state.browser.contexts().flatMap(c => c.pages());
    if (!/^\d+$/.test(args)) throw new Error('Usage: tab-select <index>, as tab-list lists the tabs');
    if (!state.tabListing.length) {
      if (!all[Number(args)]) throw new Error(`No tab [${args}]; there ${all.length === 1 ? 'is 1' : `are ${all.length}`}, and tab-list lists them`);
      state.tabListing = all.slice();
    }
    const target = state.tabListing[Number(args)];
    if (!target) throw new Error(`No tab [${args}] in your last listing; tab-list lists them again`);
    if (target.isClosed() || !all.includes(target)) throw new Error(`The tab at [${args}] in your last listing has closed; tab-list lists them again`);
    return commands.tab(args);
  },

  // playwright-cli's close ends its own session. The browser here is shared, so
  // it ends the sender's part in it: its modes are turned off, and every tab,
  // even one it opened, is left open for someone who may be using it.
  async close(args) {
    if (args) throw new Error('Usage: close');
    if (!state.client) {
      throw new Error('close turns off the modes you turned on, which needs a client name: pw-repl send -c <name> close. Without one, they cannot be told from the prompt\'s; modes lists what is on.');
    }
    await allModesOff(true);
    const own = state.browser.contexts().flatMap(c => c.pages()).filter(p => tabState(p).owner === state.client);
    if (own.length) out.log(`Tabs you opened are still open: ${own.map(p => p.url()).join(', ')}; tab close <url-part> closes one, or select it and tab close.`);
  },
};

// Hooks every page needs from the moment the REPL sees it.
function watchPage(p) {
  ensureDialogHandler(p);
  ensureRecentLog(p);
  if (nextTabWanted() && !isOpening()) watchNewTab(p);
}

// watch on --next-tab waits for a tab, and watch off stops waiting, with none selected;
// watch says it is still waiting.
function needsTab(cmd, args) {
  return !(cmd === 'watch' && (/(?:^|\s)--next-tab(?:\s|$)/.test(args) || /^\s*off\s*$/.test(args) || waitingForMe()));
}

// Tab completion for the prompt: command names first, then the fixed words
// a few commands take.
function complete(line) {
  const words = line.split(/\s+/);
  const current = words[words.length - 1];
  const match = options => {
    options = [...new Set(options)];
    const hits = options.filter(o => o.startsWith(current));
    return [hits.length ? hits : options, current];
  };
  if (words.length === 1) return match(Object.keys(commands).sort());
  const command = words[0];
  if (words.length === 2) {
    if (command === 'help') return match(['--all', ...Object.keys(HELP.TOPICS), ...Object.keys(HELP.COMMANDS).sort()]);
    if (command === 'tab') return match(['new', 'close']);
    if (command === 'network') return match(['on', 'off', 'slow']);
    if (command === 'emulate') return match([...EMULATE_KINDS, 'off']);
    if (command === 'wait') return match(['text', 'request', 'load']);
    if (command === 'modes') return match(['off']);
    if (command === 'dialog') return match(['accept', 'dismiss']);
    if (command === 'watch') return match(['on', 'off', 'new', '--all']);
    if (command === 'capture') return match(['on', 'off']);
    if (command === 'route') return match(['off']);
  }
  if (words.length >= 3 && command === 'watch' && words[1] === 'on') return match(['--changes', '--live', '--next-tab'].filter(f => !words.slice(2, -1).includes(f)));
  if (words.length === 3 && command === 'capture' && words[1] === 'on') return match(['requests', 'console']);
  if (words.length === 3 && command === 'emulate' && EMULATE_KINDS.includes(words[1])) return match(['off']);
  if (words.length === 3 && command === 'route' && words[1] === 'off') return match(['--all', ...(state.page ? routesFor(state.page).keys() : [])]);
  return [[], current];
}

module.exports = { commands, cliCommands, needsTab, dialogCommand, listTabs, openTab, markStartTab, activeModes, watchPage, complete, compactSnapshot, grepSnapshot, summarizeChanges, scrubEditable, clock };
