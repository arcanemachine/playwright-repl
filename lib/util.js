// Small helpers the commands share: output hints, clipping, times, patterns and number arguments.

const COMMAND_TIMEOUT = 15000;

const MAX_EVENT_TEXT = 4000;

// For a command that needs a tab, when none is selected.
const NO_TAB = 'No tab is selected; select one with tab <index|url-part>, or open one with tab new';

// What a command run on its own prints after its state: the commands that
// come next, set apart from the state by a blank line.
function hints(pairs) {
  const width = Math.max(...pairs.map(([command]) => command.length));
  return `\n${pairs.map(([command, what]) => `  ${command.padEnd(width)}  ${what}`).join('\n')}`;
}

function clipText(text) {
  return text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT)}…` : text;
}

function numbers(args, usage) {
  const words = (args || '').trim().split(/\s+/).filter(Boolean);
  if (words.some(w => !/^-?\d+(?:\.\d+)?$/.test(w))) throw new Error(`Usage: ${usage}, in numbers of CSS pixels`);
  return words.map(Number);
}

// For --regex, as playwright-cli's find --regex and requests --filter take one.
function regexOf(pattern) {
  try { return new RegExp(pattern); } catch (error) { throw new Error(`Not a regular expression: ${error.message}`); }
}

// A pattern without its quotes, and with \" inside them as ", as snapshot
// reads one: other backslashes are the regexp's own (\d).
function patternText(text) {
  return text.replace(/^(["'])(.*)\1$/, '$2').replace(/\\"/g, '"');
}

// Local time with its offset (18:16:15.721-06:00), so it reads against the
// user's clock and is still unambiguous.
function clock(t) {
  const d = new Date(t);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${zone}`;
}

module.exports = { COMMAND_TIMEOUT, MAX_EVENT_TEXT, NO_TAB, hints, clipText, numbers, regexOf, patternText, clock };
