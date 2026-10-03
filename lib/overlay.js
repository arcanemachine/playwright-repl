// What the REPL draws over a page (the cursor, a toast), each as a layer of one element of its own.
const { tabState } = require('./tabstate');

// Runs in the page. An element under <html>, not <body>, which frameworks replace, with a closed shadow
// root, so the page's selectors, the snapshot and text do not find what is in it. It takes no pointer
// events, so what is under it is clicked, and it is built with the DOM and inline styles, which a page's
// Trusted Types or style-src rules do not block. It is shown as a popover, in the top layer, above the
// page's own dialogs, as Playwright's highlight is. Kept on the document under a symbol, so each call
// finds it again, and one the page removed is drawn again. Each layer is a box over the whole viewport,
// in a fixed order (the cursor above a toast), whatever order they were drawn in; the element goes with
// its last layer.
function pageOverlay(create) {
  const KEY = Symbol.for('pw-repl-overlay');
  const ORDER = ['toast', 'cursor'];
  // Important on the element in the page, whose own rules could reach it; inside, the page's cannot, and
  // an important transform would win over an animation.
  const set = (el, styles, important = '') => { for (const [name, value] of Object.entries(styles)) el.style.setProperty(name, value, important); };
  let overlay = document[KEY];
  if (!overlay || !overlay.host.isConnected) {
    if (!create) return null;
    const host = document.createElement('pw-repl-overlay');
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('popover', 'manual');
    set(host, {
      display: 'block', position: 'fixed', inset: '0', width: '100%', height: '100%', 'max-width': 'none',
      'max-height': 'none', margin: '0', padding: '0', border: 'none', background: 'transparent',
      overflow: 'visible', 'pointer-events': 'none', 'z-index': '2147483647',
    }, 'important');
    const root = host.attachShadow({ mode: 'closed' });
    document.documentElement.append(host);
    const layers = {};
    overlay = document[KEY] = {
      host,
      set,
      // A layer's box, made the first time it is asked for.
      layer(name) {
        if (layers[name]) return layers[name];
        const box = document.createElement('div');
        set(box, { position: 'absolute', inset: '0', overflow: 'visible' });
        const after = ORDER.slice(ORDER.indexOf(name) + 1).map(n => layers[n]).find(Boolean);
        root.insertBefore(box, after || null);
        return (layers[name] = box);
      },
      has: name => !!layers[name],
      drop(name) {
        layers[name]?.remove();
        delete layers[name];
        if (Object.keys(layers).length) return;
        host.remove();
        delete document[KEY];
      },
    };
  }
  // Shown again, so it is above a dialog the page opened since.
  try { overlay.host.hidePopover(); overlay.host.showPopover(); } catch {}
  return overlay;
}

// Runs fn(overlay, args) in the page, fn a function of its own that uses nothing from here. A string,
// so the two functions go to the page as one call; evaluated over CDP, it is not the page's own eval,
// which a page's script-src may forbid. With create false, nothing is drawn if the overlay is not there.
function inOverlay(p, fn, args = null, create = true) {
  return p.evaluate(`(() => { const overlay = (${pageOverlay})(${create}); return overlay ? (${fn})(overlay, ${JSON.stringify(args)}) : undefined; })()`);
}

// A new document drops the overlay: each layer kept on the tab is drawn again by its redraw.
function keepAcrossPages(p, name, redraw) {
  if (!tabState(p).overlayKept) {
    tabState(p).overlayKept = new Map();
    p.on('domcontentloaded', () => { for (const again of tabState(p).overlayKept.values()) again().catch(() => {}); });
  }
  tabState(p).overlayKept.set(name, redraw);
}

function forget(p, name) {
  tabState(p).overlayKept?.delete(name);
}

module.exports = { inOverlay, keepAcrossPages, forget };
