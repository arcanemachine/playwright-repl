// Cutting or slowing a tab's network.
const { state } = require('./state');
const out = require('./output');
const { hints } = require('./util');
const { tabState } = require('./tabstate');
const { keptSession } = require('./cdp');

// DevTools' "Slow 4G".
const SLOW_DEFAULT = { latency: 563, down: 1440, up: 675 };
const SLOW_LATENCY_MAX = 10000;

// setting null restores the network.
async function setNetwork(p, setting) {
  const session = await keptSession(p);
  if (!('networkEnabled' in tabState(p))) { await session.send('Network.enable'); tabState(p).networkEnabled = true; }
  await session.send('Network.emulateNetworkConditions', {
    offline: !!setting?.offline,
    latency: setting?.latency || 0,
    // kbps to bytes per second; -1 is no limit.
    downloadThroughput: setting?.down ? setting.down * 125 : -1,
    uploadThroughput: setting?.up ? setting.up * 125 : -1,
  });
  if (setting) tabState(p).network = { ...setting, owner: state.client }; else delete tabState(p).network;
}

function networkText(setting) {
  return setting.offline ? 'off (offline)' : `slow (${setting.latency}ms latency, ${setting.down} kbps down, ${setting.up} kbps up)`;
}

const commands = {
  // A stopped upstream does not reach the browser as a failure: the dev proxy
  // holds the request open instead of refusing it. Cutting the connection at
  // the browser is what a visitor's wifi or VPN dropping looks like to the page.
  async network(args) {
    const words = (args || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const setting = tabState(state.page).network;
    if (!words.length) {
      out.log(`The selected tab's network is ${setting ? networkText(setting) : 'on'}.`);
      if (setting) out.log(hints([['network on', 'restore it']]));
      else out.log(hints([['network off', 'cut it, like dropped wifi'], ['network slow [<ms> [<kbps>]]', `slow it (default ${networkText(SLOW_DEFAULT).slice(6, -1)})`]]));
      return;
    }
    const [how, ...rest] = words;
    if ((how === 'on' || how === 'off') && !rest.length) {
      await setNetwork(state.page, how === 'on' ? null : { offline: true });
      out.log(`The selected tab's network is ${how}`);
      return;
    }
    const usage = `Usage: network [on | off | slow [<latency-ms> [<kbps>]]] (latency up to ${SLOW_LATENCY_MAX}ms)`;
    if (how !== 'slow' || rest.length > 2 || !rest.every(w => /^\d+$/.test(w))) throw new Error(usage);
    const [latency, kbps] = rest.map(Number);
    if (latency > SLOW_LATENCY_MAX || kbps === 0) throw new Error(usage);
    const slow = rest.length ? { latency, down: kbps || SLOW_DEFAULT.down, up: kbps || SLOW_DEFAULT.up } : SLOW_DEFAULT;
    await setNetwork(state.page, slow);
    out.log(`The selected tab's network is ${networkText(slow)}`);
  },
};

module.exports = { commands, setNetwork };
