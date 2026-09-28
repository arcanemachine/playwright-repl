// The CDP session kept for each tab, and keeping a background tab drawing.
const { tabState } = require('./tabstate');

// Per page: a CDP session's emulation applies to the page it is attached to
// and resets, in part, when it detaches, so one is kept for each tab.
function keptSession(p) {
  if (!('session' in tabState(p))) tabState(p).session = p.context().newCDPSession(p).catch(error => { delete tabState(p).session; throw error; });
  return tabState(p).session;
}

// Chrome all but stops drawing a tab that is not in front once it has had
// input (about a frame a second), and Playwright waits for frames to see an
// element hold still before acting on it, so each click in a tab opened in the
// background took 1-2s. A screencast keeps the tab drawing without bringing it
// to the front, for as long as the REPL runs (the throttle is back within
// seconds of stopping it). Its frames are tiny and rare; the cost is that the
// tab renders at full rate, as if in front, an animation or a video included.
async function keepDrawing(p) {
  if ('drawing' in tabState(p)) return;
  tabState(p).drawing = true;
  try {
    const session = await keptSession(p);
    session.on('Page.screencastFrame', frame => session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {}));
    await session.send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 8, maxHeight: 8, everyNthFrame: 60 });
  } catch {
    // Only slower without it.
    delete tabState(p).drawing;
  }
}

module.exports = { keptSession, keepDrawing };
