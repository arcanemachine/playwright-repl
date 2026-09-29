// Dialogs: each tab's handler, and answering one ahead of the command queue.
const { state } = require('./state');
const out = require('./output');
const { OUTPUT_LIMIT } = out;
const { unquote } = require('./syntax');
const { hints } = require('./util');
const { tabState } = require('./tabstate');
const { keptSession } = require('./cdp');

// page -> its open dialog. The page, and every command that reads it, waits
// until the dialog is answered, in the browser or with the dialog command.
const openDialogs = new Map();

// cdp's session is new, and Chrome lets only one that saw a dialog open answer it: it would wait out its
// timeout. Refused ahead of the queue too, which the dialog it means holds up.
const CDP_ANSWER = /^cdp(?:\s+--all)?\s+Page\.handleJavaScriptDialog(?:\s|$)/;
const CDP_REFUSED = 'cdp cannot answer a dialog, which Chrome lets only a session that saw it open do; dialog accept or dialog dismiss answers it';

function ensureDialogHandler(p) {
  if ('dialogHandled' in tabState(p)) return;
  tabState(p).dialogHandled = true;
  p.on('dialog', dialog => {
    openDialogs.set(p, dialog);
    out.notice(`Dialog [${dialog.type()}]: ${String(dialog.message()).slice(0, OUTPUT_LIMIT)}`, p);
    out.notice('It waits to be answered in the browser, or with dialog accept [text] | dialog dismiss; until then the page, and commands that read it, wait too.', p);
  });
  p.on('close', () => openDialogs.delete(p));
  // One answered in the browser is gone too, which Playwright does not report. The tab's own session
  // shares Playwright's connection, so a dialog's closing comes in before the next one opening.
  keptSession(p).then(async session => {
    session.on('Page.javascriptDialogClosed', () => openDialogs.delete(p));
    await session.send('Page.enable');
  }).catch(() => {});
}

// Runs ahead of the command queue (see runner.js), so it still works while
// commands wait on the dialog; it returns its output rather than printing it.
async function dialogCommand(args, selected = state.page) {
  const [action, ...rest] = (args || '').trim().split(/\s+/).filter(Boolean);
  const pages = state.browser.contexts().flatMap(c => c.pages());
  for (const p of openDialogs.keys()) if (p.isClosed() || !pages.includes(p)) openDialogs.delete(p);
  const describe = (p, d) => `[${pages.indexOf(p)}] ${p.url()}: ${d.type()} ${JSON.stringify(String(d.message()).slice(0, 200))}`;
  if (!action) {
    if (!openDialogs.size) return 'No dialog is open.';
    // With several, the one accept and dismiss answer is marked, as tab marks the selected tab.
    const mark = p => (openDialogs.size > 1 ? (p === selected ? '* ' : '  ') : '');
    return [...[...openDialogs].map(([p, d]) => `${mark(p)}${describe(p, d)}`), hints([['dialog accept [text]', 'accept it (text answers a prompt)'], ['dialog dismiss', 'dismiss it']])].join('\n');
  }
  if (action !== 'accept' && action !== 'dismiss') throw new Error('Usage: dialog [accept [text] | dismiss]');
  // The selected tab's dialog, or the only one open.
  const page = openDialogs.has(selected) ? selected : openDialogs.size === 1 ? [...openDialogs.keys()][0] : null;
  if (!page) throw new Error(openDialogs.size ? 'Several tabs have a dialog open; select one with tab <index|url-part> first' : 'No dialog is open.');
  const dialog = openDialogs.get(page);
  openDialogs.delete(page);
  const line = describe(page, dialog);
  try {
    // Without text, as OK in the browser: a prompt's default stays its answer.
    if (action === 'accept') await dialog.accept(rest.length ? unquote(rest.join(' ')) : dialog.defaultValue());
    else await dialog.dismiss();
  } catch (error) {
    // Answered in the browser meanwhile.
    return `No dialog is open (${error.message.split('\n')[0]})`;
  }
  return `${action === 'accept' ? 'Accepted' : 'Dismissed'}: ${line}`;
}

const commands = {
  async dialog(args) {
    out.log(await dialogCommand(args));
  },
};

module.exports = { commands, ensureDialogHandler, dialogCommand, CDP_ANSWER, CDP_REFUSED };
