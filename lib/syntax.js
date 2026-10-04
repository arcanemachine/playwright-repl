// How a command line's words are read, shared by the REPL and pw-repl send.

// Commands whose first word is a selector, quoted if it has spaces, and whose
// value is the rest of the line. Other commands take the rest of the line as it is.
const SELECTOR_FIRST = new Set(['fill', 'type', 'select', 'press', 'upload']);

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

// The words of a line as a shell reads them: quoted parts may hold spaces, and lose their quotes
// (--filename="my dir/a.webm" is one word, --filename=my dir/a.webm).
function shellWords(text) {
  return [...(text || '').matchAll(/(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+|["'])+/g)]
    .map(m => m[0].replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g, (_, double, single) => (double !== undefined ? double.replace(/\\(.)/g, '$1') : single)));
}

// The first word of args, or a quoted selector with spaces in it, and the rest of the line.
function splitSelector(args) {
  const match = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))(?:\s+([\s\S]*))?$/.exec((args || '').trim());
  if (!match) return null;
  const word = match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2] !== undefined ? match[2] : match[3];
  return { word, selector: toSelector(word), rest: match[4] };
}

// Key names in any case, as playwright-cli's press takes them (arrowleft), in
// the case Playwright needs (ArrowLeft); a single character is kept as it is.
const KEY_NAMES = [
  'Backquote', 'Minus', 'Equal', 'Backslash', 'Backspace', 'Tab', 'BracketLeft', 'BracketRight', 'CapsLock',
  'Semicolon', 'Quote', 'Enter', 'Comma', 'Period', 'Slash', 'Space', 'Escape', 'Shift', 'ShiftLeft', 'ShiftRight',
  'Control', 'ControlLeft', 'ControlRight', 'Meta', 'MetaLeft', 'MetaRight', 'Alt', 'AltLeft', 'AltRight',
  'AltGraph', 'ControlOrMeta', 'ContextMenu', 'PrintScreen', 'ScrollLock', 'Pause', 'PageUp', 'PageDown',
  'Insert', 'Delete', 'Home', 'End', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'NumLock', 'Clear',
  'NumpadDivide', 'NumpadMultiply', 'NumpadSubtract', 'NumpadAdd', 'NumpadDecimal', 'NumpadEnter',
  'AudioVolumeMute', 'AudioVolumeDown', 'AudioVolumeUp', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaPlayPause',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => [`Digit${i}`, `Numpad${i}`]).flat(),
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
];
const KEYS = new Map(KEY_NAMES.map(name => [name.toLowerCase(), name]));

function keyName(key) {
  // Control+Shift+ArrowLeft: each part, where + itself may be the last.
  return key.split(/\+(?!$)/).map(part => (part.length > 1 ? KEYS.get(part.toLowerCase()) || part : part)).join('+');
}

// {{ PW_NAME }} in a command send sends: a variable from the sender's environment. The REPL fills it in
// as it runs the line, so its pane and log show the line as written. Only PW_ names: {{ name }} is common
// in a page's own text (a template's), which send must neither fail on nor fill with one of the
// sender's own secrets (GITHUB_TOKEN). In double quotes the value is
// escaped as they read it (a JS string's too); anywhere else it goes in as it is. Single quotes escape
// nothing, so a value with one cannot go in them: refused, naming the variable, since a page or eval error
// that quoted the broken line would show the value.
const VARIABLE = /\{\{\s*(PW_\w+)\s*\}\}/g;

function variablesIn(line) {
  return [...new Set([...line.matchAll(VARIABLE)].map(m => m[1]))];
}

// values: { NAME: value }. Throws on a variable it has no value for.
function expandVariables(line, values) {
  const value = name => {
    if (typeof values[name] !== 'string') throw new Error(`{{ ${name} }} has no value: send --file fills it in from ${name} in its environment`);
    return values[name];
  };
  return line.replace(new RegExp(`"(?:[^"\\\\]|\\\\.)*"|'[^']*'|${VARIABLE.source}`, 'g'), (whole, name) => {
    if (name) return value(name);
    if (whole[0] === '"') return whole.replace(VARIABLE, (_, inner) => value(inner).replace(/[\\"]/g, '\\$&'));
    return whole.replace(VARIABLE, (_, inner) => {
      if (value(inner).includes("'")) throw new Error(`{{ ${inner} }} holds a ', which single quotes cannot hold: put it in double quotes`);
      return value(inner);
    });
  });
}

module.exports = { SELECTOR_FIRST, REF, toSelector, unquote, shellWords, splitSelector, keyName, variablesIn, expandVariables };
