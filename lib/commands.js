const { state, shutdown } = require('./state');
const out = require('./output');
const HELP = require('./help');
const { hints, clock } = require('./util');
const { tabState } = require('./tabstate');
const { commands: dialogsCommands, ensureDialogHandler, dialogCommand } = require('./dialogs');
const { commands: elementsCommands } = require('./elements');
const { commands: requestlogCommands, ensureRecentLog } = require('./requestlog');
const { commands: routesCommands, routesFor, unroute } = require('./routes');
const { commands: networkCommands, setNetwork } = require('./network');
const { commands: emulationCommands, EMULATE_KINDS, emulatedKinds, setEmulation } = require('./emulation');
const { commands: captureCommands, currentCapture, endCapture } = require('./capture');
const { commands: inspectCommands, compactSnapshot, grepSnapshot } = require('./inspect');
const { commands: watchCommands, summarizeChanges, scrubEditable, nextTabWanted, stopWaitingForNextTab, waitingForMe, waitingText, watchNewTab, stopWatching } = require('./watch');
const { commands: tabsCommands, markStartTab, isOpening, openTab, listTabs } = require('./tabs');


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

const commands = {
  ...tabsCommands,
  ...watchCommands,
  ...inspectCommands,
  ...captureCommands,
  ...emulationCommands,
  ...networkCommands,
  ...routesCommands,
  ...requestlogCommands,
  ...elementsCommands,
  ...dialogsCommands,

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
