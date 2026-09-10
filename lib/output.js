// All command output goes through here rather than straight to console, so a
// command run through the server can have its output collected and returned.
const OUTPUT_LIMIT = 12000;

let sink = null;

function log(text) {
  console.log(text);
  if (sink) sink.push(String(text));
}

function error(text) {
  console.error(text);
  if (sink) sink.push(String(text));
}

// Commands run one at a time, so a single sink is enough. Lines printed by
// background events while it is open (e.g. a Faked line) are collected too.
async function collect(fn) {
  sink = [];
  try {
    await fn();
    return sink.join('\n');
  } finally {
    sink = null;
  }
}

// Lines the browser causes on its own (a faked request, a dialog) can arrive
// while the prompt is showing. The entry point registers how to print above
// the prompt and redraw it, so the pane still ends on a bare prompt.
let idlePrinter = null;

function onIdlePrint(printer) {
  idlePrinter = printer;
}

function notice(text) {
  if (!sink && idlePrinter && idlePrinter.idle()) idlePrinter.print(String(text));
  else log(text);
}

function printOutput(value, all = false) {
  let text;
  if (typeof value === 'string') text = value;
  else text = JSON.stringify(value, null, 2);
  if (text === undefined) text = 'undefined';
  if (!all && text.length > OUTPUT_LIMIT) {
    log(`${text.slice(0, OUTPUT_LIMIT)}\n[truncated; use --all after the command to show all]`);
  } else {
    log(text);
  }
}

module.exports = { OUTPUT_LIMIT, log, error, collect, notice, onIdlePrint, printOutput };
