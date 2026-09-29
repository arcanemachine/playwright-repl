// The modes on in each tab, who turned each on, and turning them off.
const { state } = require('./state');
const out = require('./output');
const { hints } = require('./util');
const { tabState } = require('./tabstate');
const { unroute } = require('./routes');
const { setNetwork } = require('./network');
const { emulatedKinds, setEmulation, setViewport } = require('./emulation');
const { recordingOf, finishRecording } = require('./record');
const { currentCapture, endCapture } = require('./capture');
const { nextTabWanted, waitingText, stopWaitingForNextTab, stopWatching } = require('./watch');
const { hideHighlights } = require('./elements');

// The modes turned on in a tab, in the order the prompt shows them.
function activeModes(p) {
  const modes = [];
  if (tabState(p).watch?.on) modes.push('watch');
  const network = tabState(p).network;
  if (network) modes.push(network.offline ? 'network:off' : 'network:slow');
  const emulated = emulatedKinds(tabState(p).emulation);
  if (emulated.length) modes.push(`emulate:${emulated.join(',')}`);
  const viewport = tabState(p).viewport;
  if (viewport) modes.push(`viewport:${viewport.width}x${viewport.height}`);
  const routes = tabState(p).routes?.size;
  if (routes) modes.push(`routes:${routes}`);
  const highlights = tabState(p).highlights?.size;
  if (highlights) modes.push(`highlight:${highlights}`);
  if (currentCapture()?.page === p) modes.push('capture');
  if (recordingOf(p)) modes.push('record');
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
  // With clients' modes among them, the sender's own first: modes off turns off everyone's.
  const clients = on.some(([p]) => modeOwners(p).some(([owner]) => owner));
  out.log(hints(clients && state.client
    ? [['modes off --mine', 'turn off the ones you turned on'], ['modes off', 'turn them all off, everyone\'s']]
    : [['modes off', 'turn them all off']]));
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
  const viewport = tabState(p).viewport;
  if (viewport) owners.push([viewport.owner ?? null, 'viewport']);
  for (const [glob, route] of tabState(p).routes || []) owners.push([route.owner ?? null, `route ${glob}`]);
  for (const [selector, h] of tabState(p).highlights || []) owners.push([h.owner ?? null, `highlight ${selector}`]);
  const capture = currentCapture();
  if (capture?.page === p) owners.push([capture.owner ?? null, 'capture']);
  const recording = recordingOf(p);
  if (recording) owners.push([recording.owner ?? null, 'record']);
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
      const hidden = await hideHighlights(p, mine);
      if (hidden) done.push(`${hidden} highlight${hidden === 1 ? '' : 's'} hidden`);
      // Before the page's size is reset, which the recording would otherwise end with.
      const recording = recordingOf(p);
      if (recording && ours(recording.owner)) done.push(`record off (${(await finishRecording(recording)).replace(/\n/g, '; ')})`);
      if ('emulation' in tabState(p) && ours(tabState(p).emulation.owner)) { await setEmulation(p, {}); done.push('emulate off'); }
      if ('viewport' in tabState(p) && ours(tabState(p).viewport.owner)) { await setViewport(p, null); done.push('viewport off'); }
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
  async modes(args) {
    const arg = (args || '').trim();
    if (!arg) return listModes();
    if (arg !== 'off' && arg !== 'off --mine') throw new Error('Usage: modes [off [--mine]]');
    await allModesOff(arg === 'off --mine');
  },
};

module.exports = { commands, activeModes, allModesOff };
