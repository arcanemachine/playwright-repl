// Everything the REPL keeps about a tab, in one record per page. A WeakMap, so a closed page's
// record goes with it: the shutdown cleanups walk the browser's pages instead of the records.
//   dialogHandled  its dialog handler is on
//   session        the CDP session kept for it (a promise)
//   drawing        it is kept drawing in the background
//   targetId       its CDP target id
//   networkEnabled its CDP session has Network on
//   network        how its network is changed: { offline: true }, or slowed { latency, down, up }
//                  (ms, kbps), with the owner
//   emulation      what emulate changed: { device, scheme, locale, timezone }, each unset when off,
//                  with the owner
//   viewport       the size viewport set: { width, height }, with the owner
//   recording      its recording (record on): the ffmpeg writing it, its file, its owner
//   routes         Map(glob -> { status, body, handler, owner })
//   log            its recent requests (requests)
//   consoleLog     its recent console messages and page errors (console)
//   loadedAt       when its page last fired its load event
//   bodiesDurable  the browser keeps its response bodies after it navigates
//   opened         this REPL opened it with tab new
//   owner          the client that opened it (null: the prompt, or a sender without a name)
//   start          the REPL opened it for its start URL
//   watch          its watch: the steps recorded, and whether it is on
//   watchStarting  its watch on --next-tab is still starting: the page can load before it is ready
//   watchBinding   its binding's record function; the binding is added once per tab
const tabStates = new WeakMap();

function tabState(p) {
  // No tab selected: an empty record, as a WeakMap's get finds nothing. It is not kept, so a
  // write to it is lost (a WeakMap's set would throw): the runner keeps commands that need a tab
  // from running without one, and nothing may rely on it holding anything.
  if (!p) return {};
  let record = tabStates.get(p);
  if (!record) tabStates.set(p, record = {});
  return record;
}

module.exports = { tabState };
