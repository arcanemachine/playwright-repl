// playwright-cli's command names, for agents who know that tool: each is
// rewritten to the pw-repl command that does the same, or refused with the
// nearest one. Names both tools share (goto, click, fill, snapshot, eval, ...)
// are pw-repl's own commands already.

const { unquote } = require('./syntax');

// name -> [what pw-repl runs (from the arguments), how it is written here]
const NAMES = {
  'tab-list': [() => 'tab', 'tab'],
  'tab-new': [a => `tab new ${a}`.trim(), 'tab new [url]'],
  // By index only, unlike tab <number>, which falls back to a URL containing it.
  'tab-select': [a => `tab-select ${a}`, 'tab <index>, by index only'],
  // By index there, by URL here: a number could match a port in another tab's URL.
  'tab-close': [a => (a ? null : 'tab close'), 'tab close [url-part], or tab <index> then tab close'],
  open: [a => `tab new ${a}`.trim(), 'tab new [url]; --mobile or --device=<name> is emulate mobile [name]'],
  // It ends playwright-cli's own browser; this one is shared, so tabs stay open.
  close: [() => 'close', 'modes off --mine, and tabs stay open'],
  'go-back': [() => 'back', 'back'],
  'go-forward': [() => 'forward', 'forward'],
  find: [a => `snapshot --grep ${a}`, 'snapshot --grep <text>'],
  'dialog-accept': [a => `dialog accept ${a}`.trim(), 'dialog accept [text]'],
  'dialog-dismiss': [() => 'dialog dismiss', 'dialog dismiss'],
  resize: [a => { const [w, h] = a.split(/\s+/); return w && h ? `viewport ${w}x${h}` : null; }, 'viewport <w>x<h>'],
  'cookie-list': [() => 'cookies', 'cookies'],
  'localstorage-list': [() => 'storage', 'storage'],
  'set-color-scheme': [a => (/^(dark|light)$/.test(a) ? `emulate ${a}` : null), 'emulate dark|light'],
  'clear-color-scheme': [() => 'emulate dark off', 'emulate dark off'],
  'network-state-set': [a => ({ offline: 'network off', online: 'network on' })[a] || null, 'network off|on'],
  'route-list': [() => 'route', 'route'],
  unroute: [a => (a ? `route off ${a}` : 'route off --all'), 'route off <glob>|--all'],
  request: [a => `body ${a}`, 'body <#>'],
  'response-body': [a => `body ${a}`, 'body <#>'],
};

// The nearest pw-repl command for names it has no counterpart for.
const NEAREST = {
  'run-code': 'eval <JavaScript> runs in the page; cdp <method> <json> sends a CDP command',
  'recording-start': 'watch on records what a person does, step by step, and watch reads it back',
  'recording-stop': 'watch off, then watch',
  'tracing-start': 'capture on records requests and console messages together',
  'tracing-stop': 'capture off',
  upload: 'upload <selector> <file>... chooses the files, through the input or the button that opens it',
  list: 'pw-repl where says which REPL is running; one REPL serves everyone using its browser',
  attach: 'pw-repl serve connects to the browser on PW_CDP_URL; pw-repl skill has the rest',
  detach: 'pw-repl stop, or quit at the prompt, disconnects and leaves the browser running',
};

const NAME_LIST = Object.keys(NAMES);

// playwright-cli's options on the commands both tools have, and on those
// rewritten here: flag (no value), value, or rest (the rest of the line up to
// the next option, for a body with spaces). One this tool does not take is
// refused, rather than read as part of a selector, a value or a file name.
const OPTIONS = {
  click: { modifiers: 'value' },
  dblclick: { modifiers: 'value' },
  fill: { submit: 'flag' },
  type: { submit: 'flag' },
  eval: { filename: 'value' },
  find: { regex: 'rest' },
  screenshot: { filename: 'value', type: 'value', 'full-page': 'flag', hires: 'flag' },
  snapshot: { filename: 'value', depth: 'value', boxes: 'flag' },
  console: { clear: 'flag' },
  requests: { static: 'flag', filter: 'value', clear: 'flag' },
  request: { filename: 'value' },
  'response-body': { filename: 'value' },
  route: { status: 'value', body: 'rest', 'content-type': 'value', header: 'value', 'remove-header': 'value' },
  open: { browser: 'value', config: 'value', device: 'value', headed: 'flag', 'idle-timeout': 'value', mobile: 'flag', persistent: 'flag', profile: 'value' },
  'cookie-list': { domain: 'value', path: 'value' },
};

// Options each command takes here; the rest of OPTIONS are refused.
const TAKEN = {
  route: ['status', 'body', 'content-type'],
  fill: ['submit'],
  screenshot: ['filename', 'full-page'],
  open: ['mobile', 'device'],
  click: ['modifiers'],
  find: ['regex'],
  requests: ['static', 'filter'],
  dblclick: ['modifiers'],
  type: ['submit'],
};

// What to do instead of an option that is refused, where there is something.
const INSTEAD = {
  'snapshot --depth': 'snapshot <ref> outlines one element, and snapshot --grep <text> finds lines',
  'snapshot --filename': 'the snapshot is printed; pw-repl send ... > file saves it',
  'eval --filename': 'the result is printed; pw-repl send ... > file saves it',
  'request --filename': 'the body is printed; pw-repl send ... > file saves it',
  'response-body --filename': 'the body is printed; pw-repl send ... > file saves it',
  'screenshot --hires': 'screenshots are at CSS pixel size',
  'route --header': 'route <glob> patch <json> changes a JSON response',
  'route --remove-header': 'route <glob> patch <json> changes a JSON response',
  'cookie-list --domain': 'cookies lists them all',
  'cookie-list --path': 'cookies lists them all',
};
for (const option of ['browser', 'config', 'headed', 'idle-timeout', 'persistent', 'profile']) {
  INSTEAD[`open --${option}`] = 'the REPL uses the browser it connected to; pw-repl serve --launch [--headed] starts one of its own';
}

// A word, where quoted parts may hold spaces: --device="iPhone 15".
const TOKEN = /(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+|["'])+/g;

// The options of spec found in args, and the line without them.
function takeOptions(args, spec) {
  const tokens = [...args.matchAll(TOKEN)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
  const optionAt = i => {
    const match = /^--([A-Za-z][\w-]*)(?:=([\s\S]*))?$/.exec(tokens[i]?.text || '');
    return match && Object.hasOwn(spec, match[1]) ? { name: match[1], value: match[2] } : null;
  };
  const found = [];
  const cuts = [];
  for (let i = 0; i < tokens.length; i++) {
    const option = optionAt(i);
    if (!option) continue;
    const start = tokens[i].start;
    let end = tokens[i].end;
    let { value } = option;
    if (spec[option.name] === 'rest') {
      let next = i + 1;
      while (next < tokens.length && !optionAt(next)) next++;
      end = next < tokens.length ? tokens[next].start : args.length;
      value = args.slice(value === undefined ? tokens[i].end : start + option.name.length + 3, end).trim() || undefined;
      i = next - 1;
    } else if (spec[option.name] === 'value' && value === undefined && tokens[i + 1] && !tokens[i + 1].text.startsWith('--')) {
      value = tokens[++i].text;
      end = tokens[i].end;
    }
    // raw keeps a value as typed, quotes and backslashes and all, for a regexp.
    found.push({ name: option.name, value: value === undefined ? undefined : unquote(value), raw: value });
    cuts.push([start, end]);
  }
  let rest = '';
  let at = 0;
  for (const [start, end] of cuts) { rest += `${args.slice(at, start).trim()} `; at = end; }
  rest += args.slice(at).trim();
  return { found, rest: rest.trim() };
}

// { text } to run instead, { refuse } to explain, or null for any other command.
function translate(text) {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const [, name, rest = ''] = match;
  const args = rest.trim();
  if (Object.hasOwn(OPTIONS, name)) {
    const { found, rest: positional } = takeOptions(args, OPTIONS[name]);
    // route <glob> <how> ... is this tool's own, and its body is free text.
    if (name === 'route' && (positional.match(TOKEN) || []).length > 1) return null;
    const refused = found.find(o => !(TAKEN[name] || []).includes(o.name));
    if (refused) {
      const instead = INSTEAD[`${name} --${refused.name}`];
      return { refuse: `playwright-cli's ${name} --${refused.name} is not supported here${instead ? `; ${instead}` : ''}` };
    }
  }
  // route <pattern> [--status=<code>] [--body=<text>] [--content-type=<type>] is how
  // playwright-cli fakes a response; the status is 200 unless given, and a body
  // that is not JSON is text unless its type is given.
  if (name === 'route' && /(?:^|\s)--(?:status|body|content-type)(?:[=\s]|$)/.test(args)) {
    const { found, rest: glob } = takeOptions(args, OPTIONS.route);
    // route <glob> <status> --content-type=<type> <body> is this tool's own.
    if (/\s/.test(unquote(glob))) return null;
    const option = key => found.find(o => o.name === key)?.value;
    const status = option('status') ?? '200';
    const body = option('body') ?? '';
    if (!/^\d{3}$/.test(status) || !glob) return { refuse: 'Usage: route <pattern> [--status=<code>] [--body=<text>] [--content-type=<type>]' };
    let json = true;
    try { if (body) JSON.parse(body); } catch { json = false; }
    const type = option('content-type') ?? (json ? null : 'text/plain');
    const typeWord = type && /\s/.test(type) ? JSON.stringify(type) : type;
    return { text: `route ${unquote(glob)} ${status}${type ? ` --content-type=${typeWord}` : ''}${body ? ` ${body}` : ''}`, as: 'route <glob> <status> [--content-type=<type>] [body]' };
  }
  // find --regex takes a regular expression, as snapshot --regex does; requests --filter
  // takes one too, as requests --regex does, and --static is --all.
  if (name === 'find' && /(?:^|\s)--regex(?:[=\s]|$)/.test(args)) {
    // As typed: snapshot --regex takes off the quotes and leaves its backslashes.
    const regex = takeOptions(args, OPTIONS.find).found[0].raw;
    return regex ? { text: `snapshot --regex ${regex}`, as: 'snapshot --regex <pattern>', key: 'find --regex' } : { refuse: 'Usage: find --regex <pattern>' };
  }
  if (name === 'requests' && /(?:^|\s)--(?:static|filter)(?:[=\s]|$)/.test(args)) {
    const { found, rest } = takeOptions(args, OPTIONS.requests);
    const filter = found.find(o => o.name === 'filter');
    if (filter && !filter.value) return { refuse: 'Usage: requests --filter=<regexp>' };
    const all = found.some(o => o.name === 'static');
    // As typed: requests --regex takes off the quotes and leaves its backslashes.
    const text = ['requests', all && '--all', rest, filter && `--regex ${filter.raw}`].filter(Boolean).join(' ');
    return filter ? { text, as: 'requests --regex <pattern>', key: 'requests --filter' } : { text, as: 'requests --all', key: 'requests --static' };
  }
  // open [url] [--mobile | --device=<name>]: the emulation is set before the page loads.
  if (name === 'open') {
    const { found, rest: url } = takeOptions(args, OPTIONS.open);
    const device = found.find(o => o.name === 'device');
    if (!device && !found.length) return { text: `tab new ${url}`.trim(), as: 'tab new [url]' };
    if (device && !device.value) return { refuse: 'Usage: open [url] [--mobile | --device=<name>]' };
    return {
      steps: ['tab new', `emulate mobile${device ? ` ${device.value}` : ''}`, ...(url ? [`goto ${url}`] : [])],
      as: 'tab new, emulate mobile [device], then goto <url>',
      failed: 'The new tab stays open and selected; tab close closes it.',
    };
  }
  if (Object.hasOwn(NAMES, name)) {
    const [make, as] = NAMES[name];
    const made = make(args);
    return made ? { text: made, as } : { refuse: `${name} ${args}`.trim() + ` is not understood here; the command for it is ${as}` };
  }
  if (Object.hasOwn(NEAREST, name) && name !== 'upload') return { refuse: `${name} is playwright-cli's; here, ${NEAREST[name]}` };
  return null;
}

// For help playwright-cli.
function table() {
  const width = Math.max(...NAME_LIST.map(n => n.length));
  const lines = NAME_LIST.map(n => `  ${n.padEnd(width)}  ${NAMES[n][1]}`);
  const nearest = Object.entries(NEAREST).map(([n, what]) => `  ${n.padEnd(width)}  ${what}`);
  return [...lines, '', 'Not here as such:', ...nearest].join('\n');
}

module.exports = { translate, table, takeOptions, NAME_LIST };
