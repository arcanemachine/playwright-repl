// Three levels: `help` (what this is + topics), `help <topic>` (one line per
// command), `help <command>` (usage and caveats). Keep each level short enough
// that a reader only goes deeper when they need to. Help describes what the
// tool does; instructions for agents belong in skill/SKILL.md.

const OVERVIEW = `playwright-repl drives Chromium over CDP. Commands act on the selected tab (\`tab\` shows which).
The browser may be a shared session, with other people's tabs open in it.

Common tasks:
  where am I?                       tab, info
  what is on the page?              snapshot, screenshot
  do something on it                click, fill, press
  what did the page request?        requests, then body <#> for what one got back
  console messages and errors       console
  show an agent what I do           watch on, click around, then watch
  see each step as I click          watch on --live
  requests and console together     capture on, then capture off
  break the backend on purpose      route <glob> <status> <json>, network off
  clean up                          modes off

Modes (watch, capture, route, network off) stay on until turned off; the prompt shows the selected tab's:
(watch routes:1) pw>. tab, watch, capture, route, network and modes on their own show their state and
what you can run next.

Topics (help <topic>):
  tabs      open, select, close, navigate        network   requests, bodies, console, fakes, network off
  interact  click, fill, type, press, select     devtools  eval, CDP commands, cookie and storage names
  inspect   snapshot, watch, text, screenshots   session   modes, markers, server, quitting

help <command> for usage and caveats (e.g. help route); help --all for everything.`;

const TOPICS = {
  tabs: {
    intro: 'The REPL selects tab [0] when it starts; tab on its own lists them all. After tab close, see help tab.',
    commands: ['tab', 'goto', 'back', 'forward', 'reload', 'info'],
  },
  interact: {
    intro: 'Selectors are Playwright selectors (CSS, text=..., role=...). Commands use the first match.',
    commands: ['click', 'dblclick', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck'],
  },
  inspect: {
    intro: 'Output is capped; put --all right after the command for everything (e.g. text --all body).',
    commands: ['snapshot', 'watch', 'text', 'html', 'attrs', 'count', 'visible', 'links', 'inputs', 'screenshot', 'viewport', 'wait', 'sleep'],
  },
  network: {
    intro: 'requests and console record all the time; a capture records only while it runs.',
    commands: ['requests', 'body', 'console', 'capture', 'route', 'network'],
  },
  devtools: {
    intro: 'Cookie and storage listings omit values. eval, html, screenshots and URLs can still show sensitive data.',
    commands: ['eval', 'cdp', 'cookies', 'storage'],
  },
  session: {
    intro: `Completion: @<id> <command> makes the REPL print [[pw-done:<id>:ok|error]] when it finishes.

Unknown outcome: a timed-out command may still be running, so the REPL disconnects instead of continuing.

Server: pw-repl serve also takes commands on /tmp/playwright-repl.sock; they show here as [server] lines.

The prompt is pw[serve]> while the server is on and pw> without it. Before it are the modes on in the
selected tab, if any: (watch network:off routes:2 capture) pw>. modes lists them for every tab.

Times (requests, console, watch) are local, with their UTC offset: 18:16:15.721-06:00.

Dialogs are reported and never answered automatically.`,
    commands: ['modes', 'help', 'quit'],
  },
};

const COMMANDS = {
  tab: {
    usage: 'tab [<index>|<url-part>|new [url]|close [url-part]]',
    summary: 'list tabs (* is selected); select, open or close one',
    detail: 'tab <index> uses the numbers from the latest tab listing; they change when tabs open or close.\n\ntab <url-part> selects the one tab whose URL contains it, and refuses if none or several do.\n\ntab new opens and selects a tab. tab close closes the selected tab, or the one matching url-part.\n\nClosing the selected tab goes back to the previous tab if tab new opened it; otherwise no tab is\nselected, and commands that need one refuse until one is.',
  },
  goto: { usage: 'goto <url>', summary: 'navigate the selected tab; https:// is assumed' },
  back: { usage: 'back', summary: 'go back one history entry' },
  forward: { usage: 'forward', summary: 'go forward one history entry' },
  reload: { usage: 'reload', summary: 'reload the selected tab' },
  info: { usage: 'info', summary: 'selected tab URL, title and viewport' },
  click: { usage: 'click <selector>', summary: 'click the first match' },
  dblclick: { usage: 'dblclick <selector>', summary: 'double-click the first match' },
  hover: { usage: 'hover <selector>', summary: 'hover the first match' },
  fill: { usage: 'fill <selector> => <value>', summary: 'clear an input and fill it' },
  type: { usage: 'type <selector> => <text>', summary: 'type into an input key by key' },
  press: { usage: 'press <key> | press <selector> => <key>', summary: 'press a key, optionally on an element' },
  select: { usage: 'select <selector> => <value>', summary: 'choose an option in a select' },
  check: { usage: 'check <selector>', summary: 'check a checkbox' },
  uncheck: { usage: 'uncheck <selector>', summary: 'uncheck a checkbox' },
  snapshot: {
    usage: 'snapshot [--full] [--grep <text> | <eN> | selector]',
    summary: 'outline by role and name, with [ref=eN] labels',
    detail: 'Playwright\'s accessibility snapshot, with unnamed layout wrappers (generic) and cursor hints left\nout; --full shows it unchanged.\n\n--grep <text> prints only the lines containing text (role, name or flag such as [disabled], any\ncase), each with the named elements around it. A hit with no named element around it prints without\na path.\n\nsnapshot e3 outlines one element. A label (e3, or f1e3 in newer Playwright) works as a selector:\nclick aria-ref=e3. Labels can change when the page navigates (e102 may become f4e98), so take a new\nsnapshot after one.\n\nOutput over 60 lines ends with a line count.',
  },
  watch: {
    usage: 'watch on [--changes] [--live] | off | [n|new]',
    summary: 'record what happens in the tab; show the last n steps',
    detail: 'Off until watch on. Records clicks, typing (once it pauses), Enter and Escape, form changes, submits\nand navigations, each described by role and name like snapshot, with up to 5 of the requests it\ncaused underneath (their numbers in requests; body <#> for one), leaving out scripts and what\nrequests hides. The REPL\'s own fill is recorded as type.\n\nwatch on its own says whether it is on and shows the last 20 steps; watch <n> shows the last n.\nwatch new shows only the steps it has not shown yet, and requests that have since arrived for the\nlast one.\n\n--live also prints each step in the REPL window (never in a command\'s answer) once it settles, with\nits requests and changes, marked [watch], or [watch <url>] for a tab that is not the selected one.\nA step cut short by the next one, or by watch off, prints at once; changes it made then show under the\nnext step.\n\n--changes also shows what each step changed on the page once it settles, in up to 5 lines: + added,\n- removed, ~ changed, each element once with the first names inside it. Not for navigations.\n\nTyped values are not recorded, and password fields not at all; --changes leaves out field values,\nbut what the page itself shows (e.g. "Hello <name>") is shown. Nothing is replayed.',
  },
  text: { usage: 'text [--all] <selector>', summary: 'visible text of the first match' },
  html: { usage: 'html [--all] <selector>', summary: 'outer HTML of the first match' },
  attrs: { usage: 'attrs [--all] <selector>', summary: 'attributes of the first match' },
  count: { usage: 'count <selector>', summary: 'number of matches' },
  visible: { usage: 'visible <selector>', summary: 'whether the first match is visible' },
  links: { usage: 'links [--all]', summary: 'links on the page (text and href)' },
  inputs: { usage: 'inputs [--all]', summary: 'form controls on the page; values are omitted' },
  screenshot: {
    usage: 'screenshot [--full] [--delay|-d <seconds>] [name]',
    summary: 'save a PNG of the viewport (or --full page)',
    detail: 'Saved as screenshot-<name or timestamp>.png in $PW_SCREENSHOT_DIR (default /tmp).\n\n--delay counts down out loud first (maximum 60s), so someone can hold a hover or open a menu.',
  },
  viewport: { usage: 'viewport [WxH]', summary: 'show or set the viewport size' },
  wait: {
    usage: 'wait [text|request] <what> [secs]',
    summary: 'wait for an element, text, or a response (default 10s)',
    detail: 'wait <selector> waits for a matching element; wait text <text> for text to be visible; wait request\n<url-part|glob> for a matching response, counting one that finished since the previous command began\n(so click, then wait request, does not miss it).\n\nUp to 120s. A wait that times out is an error; the REPL carries on.',
  },
  sleep: { usage: 'sleep <ms>', summary: 'wait a fixed time (maximum 3600000)' },
  requests: {
    usage: 'requests [--all] [n] [url-filter]',
    summary: 'the selected tab\'s last n requests (default 20)',
    detail: 'Recording starts when the REPL connects; the last 200 per tab are kept. Each line: #number, time,\nmethod, status (HTTP code, pending, no response, failed: <reason>, or <code> faked), duration, URL.\nA request that finished a moment ago can still show pending.\n\nbody <#> shows what a request got back.\n\nImages, fonts, stylesheets, media and extension requests are hidden unless --all is given.\n\nurl-filter is a substring: requests 20 /api/ shows API calls only, e.g. when dev-server scripts\ncrowd the list.',
  },
  body: {
    usage: 'body [--all] <#>',
    summary: 'the response body of request <#> from requests',
    detail: 'Read from the browser on demand: JSON is pretty-printed, binary is not shown, output is capped. The\nbrowser may drop a body (e.g. after the tab navigates); then body reports not available.\n\nBodies can contain sensitive data.',
  },
  console: {
    usage: 'console [--all] [n] [filter]',
    summary: 'the last n console messages and page errors',
    detail: 'Recording starts when the REPL connects; the last 200 per tab are kept. Each line: time, [type],\ntext. Types are console levels (log, warning, error, ...) and pageerror for uncaught exceptions.\n\nfilter matches the type or the text, e.g. console error.',
  },
  capture: {
    usage: 'capture on [requests|console] [secs] | off',
    summary: 'record requests and console together, in time order',
    detail: 'capture on records both until capture off, which prints them; requests or console records only one.\nWith secs (1-3600 seconds) it records that long, then prints; the REPL waits meanwhile.\n\nOne capture runs at a time, on the tab selected when it started. Unlike requests and console it\nkeeps more than the last 200 and lists both together.\n\ncapture on its own says whether one is running, or shows the last one.',
  },
  route: {
    usage: 'route <glob> <status> <json> | off <glob>|--all',
    summary: 'answer the selected tab\'s matching requests with fake JSON',
    detail: 'The fake is fulfilled inside the browser, so the page handles it as a real response and the request\nnever reaches the network. Each one prints "Faked: #<n> <METHOD> <url> -> <status>", with #<n> as in\nrequests. If fulfilling fails it prints "Fake failed" and aborts the request, so it never reaches\nthe network.\n\nStatus: 200-599. wait request <glob> after the page loads prints the request with its status, so a\nfake shows as <status> faked.\n\nRoutes belong to the tab and last until route off <glob> (or route off --all) or the REPL exits.\nRouting the same glob again replaces it. route on its own lists the selected tab\'s routes.\n\nExample: route **/api/health_check 503 {"detail":{"code":"service_unavailable"}}',
  },
  network: {
    usage: 'network [on|off]',
    summary: 'cut or restore the tab\'s network, like dropped wifi',
    detail: 'Stopping a service is not the same: a dev proxy in front of it usually holds the request open, so\nthe page spins instead of failing.\n\nPer tab; lasts until network on or the REPL exits.',
  },
  eval: {
    usage: 'eval [--all] <JavaScript>',
    summary: 'evaluate JavaScript in the selected tab and print the result',
    detail: 'Promises are awaited. eval fetch(...) sends a new request, which can change state on the server; it\ncannot read one that already happened (requests lists those).',
  },
  cdp: {
    usage: 'cdp [--all] <method> <JSON object>',
    summary: 'send one CDP command through a temporary session',
    detail: 'The session is detached afterwards, so subscriptions and settings do not persist.\n\nBrowser.close and Target.closeTarget are refused.',
  },
  cookies: { usage: 'cookies [--all]', summary: 'cookie names, domains and flags; values are omitted' },
  storage: { usage: 'storage [--all]', summary: 'localStorage keys; values are omitted' },
  modes: {
    usage: 'modes [off]',
    summary: 'the modes on in every tab; modes off turns them all off',
    detail: 'The modes are watch, network off, route and capture. Each is turned on and off with its own command:\nwatch on|off, network off|on, route <glob> ... | route off, capture on|off.\n\nmodes off turns off every one in every tab; a capture it stops is kept for capture to show.',
  },
  help: { usage: 'help [topic | command | --all]', summary: 'this help; --all prints every topic and command in full' },
  quit: {
    usage: 'quit',
    summary: 'disconnect, leaving Chromium running',
    detail: 'Runs immediately, even while another command is waiting. Only available at the prompt.',
  },
};

function commandLines(names) {
  const width = Math.max(...names.map(n => COMMANDS[n].usage.length));
  return names.map(n => `  ${COMMANDS[n].usage.padEnd(width)}  ${COMMANDS[n].summary}`);
}

function renderCommand(name) {
  const entry = COMMANDS[name];
  return [`${entry.usage} — ${entry.summary}`, ...(entry.detail ? ['', entry.detail] : [])].join('\n');
}

// Every topic's command list, with each command's details indented under it.
function renderAll() {
  const sections = Object.entries(TOPICS).map(([name, topic]) => {
    const lines = commandLines(topic.commands).flatMap((line, i) => {
      const detail = COMMANDS[topic.commands[i]].detail;
      return detail ? [line, ...detail.split('\n').map(d => (d ? `      ${d}` : '')), ''] : [line];
    });
    if (lines[lines.length - 1] === '') lines.pop();
    return [`== ${name} ==`, topic.intro, '', ...lines].join('\n');
  });
  return [OVERVIEW, ...sections].join('\n\n');
}

function render(topicOrCommand) {
  if (!topicOrCommand) return OVERVIEW;
  if (topicOrCommand === '--all') return renderAll();
  if (Object.hasOwn(TOPICS, topicOrCommand)) {
    const topic = TOPICS[topicOrCommand];
    const text = [topic.intro, '', ...commandLines(topic.commands)].join('\n');
    // A topic can share its name with a command (network); both are shown.
    return Object.hasOwn(COMMANDS, topicOrCommand) ? `${text}\n\n${renderCommand(topicOrCommand)}` : text;
  }
  if (Object.hasOwn(COMMANDS, topicOrCommand)) return renderCommand(topicOrCommand);
  return null;
}

module.exports = { render, TOPICS, COMMANDS };
