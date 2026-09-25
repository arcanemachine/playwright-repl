// How a command line's words are read, shared by the REPL and pw-repl send.

// Commands whose first word is a selector, quoted if it has spaces, and whose
// value is the rest of the line. Other commands take the rest of the line as it is.
const SELECTOR_FIRST = new Set(['fill', 'type', 'select', 'press']);

// A snapshot ref (e5, or f1e5 in newer Playwright) stands for aria-ref=e5.
const REF = /^(?:f\d+)?e\d+$/;

function toSelector(word) {
  return REF.test(word) ? `aria-ref=${word}` : word;
}

// Quotes around the whole of a value are removed; \" inside double quotes is a quote.
function unquote(text) {
  const match = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/.exec(text);
  if (!match) return text;
  return match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2];
}

// The first word of args, or a quoted selector with spaces in it, and the rest of the line.
function splitSelector(args) {
  const match = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))(?:\s+([\s\S]*))?$/.exec((args || '').trim());
  if (!match) return null;
  const word = match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2] !== undefined ? match[2] : match[3];
  return { word, selector: toSelector(word), rest: match[4] };
}

module.exports = { SELECTOR_FIRST, toSelector, unquote, splitSelector };
