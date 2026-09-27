// playwright-cli's command names, for agents who know that tool: each is
// rewritten to the pw-repl command that does the same, or refused with the
// nearest one. Names both tools share (goto, click, fill, snapshot, eval, ...)
// are pw-repl's own commands already.

// name -> [what pw-repl runs (from the arguments), how it is written here]
const NAMES = {
  'tab-list': [() => 'tab', 'tab'],
  'tab-new': [a => `tab new ${a}`.trim(), 'tab new [url]'],
  'tab-select': [a => `tab ${a}`, 'tab <index>'],
  // By index there, by URL here: a number could match a port in another tab's URL.
  'tab-close': [a => (a ? null : 'tab close'), 'tab close [url-part], or tab <index> then tab close'],
  open: [a => (a ? `tab new ${a}` : null), 'tab new <url>'],
  close: [() => 'tab close', 'tab close'],
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

// { text } to run instead, { refuse } to explain, or null for any other command.
function translate(text) {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const [, name, rest = ''] = match;
  const args = rest.trim();
  // route <pattern> --status=<code> [--body=<json>] is how playwright-cli fakes a response.
  if (name === 'route' && /(?:^|\s)--status=/.test(args)) {
    const glob = args.split(/\s+/)[0];
    const status = /--status=(\d{3})/.exec(args)?.[1];
    const body = /--body=(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/.exec(args);
    if (!status) return { refuse: 'route <glob> <status> <json-body> fakes a response here, e.g. route **/api 500 {"error":1}' };
    return { text: `route ${glob} ${status} ${body ? body[1] ?? body[2]?.replace(/\\(.)/g, '$1') ?? body[3] : '{}'}`, as: 'route <glob> <status> <json-body>' };
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

module.exports = { translate, table, NAME_LIST };
