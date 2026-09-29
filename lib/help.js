// Three levels: `help` (what this is + topics), `help <topic>` (one line per
// command), `help <command>` (usage and caveats). Keep each level short enough
// that a reader only goes deeper when they need to. Help describes what the
// tool does; instructions for agents belong in skill/SKILL.md.

// Help is written as plain paragraphs, and laid out here: each is re-flowed to WIDTH columns (help
// --all indents details by 6, within the 110 a pane shows). A paragraph with any line that is not
// plain prose (starting with "- " or whitespace, or with two spaces in a row: a bullet, a table, an
// indented example) is kept as it is written.
const WIDTH = 104;

function wrap(text, width = WIDTH) {
  return text.split('\n\n').map(paragraph => {
    const lines = paragraph.split('\n');
    if (lines.some(line => /^- |^\s|  /.test(line))) return paragraph;
    const flowed = [];
    let line = null;
    for (const word of lines.join(' ').split(' ')) {
      if (line !== null && `${line} ${word}`.length > width) { flowed.push(line); line = word; } else line = line === null ? word : `${line} ${word}`;
    }
    return [...flowed, line].join('\n');
  }).join('\n\n');
}

const OVERVIEW = wrap(`playwright-repl drives Chromium over CDP. Commands act on the selected tab (\`tab\` shows which).
The browser may be a shared session, with other people's tabs open in it.

Common tasks:
  where am I?                       tab, info
  what is on the page?              snapshot, screenshot
  do something on it                click, fill, press
  wait for a page or element        wait load, wait <selector>, wait <selector> --gone
  choose a file in a file input     upload <selector> <file>
  see it as a phone, or dark        emulate mobile, emulate dark
  what did the page request?        requests, then body <#> for what one got back
  console messages and errors       console
  show an agent what I do           watch on, click around, then watch
  see each step as I click          watch on --live
  watch a tab someone will open     watch on --next-tab [url-part]
  requests and console together     capture on, then capture off
  break the backend on purpose      route <glob> <status> <json>, route <glob> abort, network off
  change or slow an API response    route <glob> patch <json>, route <glob> delay <secs>
  slow the whole network            network slow
  clean up                          modes off

Modes (watch, capture, route, network off or slow, emulate) stay on until turned off; the prompt shows
the selected tab's: (watch routes:1) pw>. tab, watch, capture, route, network, emulate and modes on
their own show their state and what you can run next.

Topics (help <topic>):
  tabs      open, select, close, navigate        network   requests, bodies, console, fakes, network off
  interact  click, fill, type, press, select     devtools  eval, CDP commands, cookie and storage names
  inspect   snapshot, watch, text, screenshots   session   modes, markers, server, quitting

help <command> for usage and caveats (e.g. help route); help --all for everything.

Know playwright-cli? Its command names work here too (tab-list, go-back, set-color-scheme, route
--status=...); help playwright-cli lists them.`);

const TOPICS = {
  tabs: {
    intro: `No tab is selected when the REPL starts: tab new opens one, tab <index|url-part> selects one.
tab on its own lists them all.`,
    commands: ['tab', 'goto', 'back', 'forward', 'reload', 'info'],
  },
  interact: {
    intro: `Selectors are Playwright selectors (CSS, text=..., role=...) or snapshot refs such as e5.
Commands use the first match (click, dblclick and hover the first they can use: help click); see help
fill for selectors with spaces. mousemove and the other mouse commands act at a point instead.`,
    commands: ['click', 'dblclick', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'upload', 'mousemove', 'mousedown', 'mouseup', 'mousewheel'],
  },
  inspect: {
    intro: `Output is capped; --all right after the command, or at the end, shows everything (text --all body).`,
    commands: ['snapshot', 'watch', 'text', 'html', 'attrs', 'listeners', 'count', 'visible', 'links', 'inputs', 'screenshot', 'viewport', 'emulate', 'wait', 'sleep'],
  },
  network: {
    intro: `requests and console record all the time; a capture records only while it runs.`,
    commands: ['requests', 'body', 'console', 'capture', 'route', 'network'],
  },
  devtools: {
    intro: `Cookie and storage listings omit values. eval, cdp, html, screenshots and URLs can still show
sensitive data (cdp Network.getCookies shows cookie values).`,
    commands: ['eval', 'cdp', 'cookies', 'storage'],
  },
  session: {
    intro: `Completion: @<id> <command> makes the REPL print [[pw-done:<id>:ok|error]] when it finishes.

Unknown outcome: a command that timed out after it began acting on the page may or may not have done
it. It says so (pw-repl send exits 2), and the REPL carries on.

Server: pw-repl serve also takes commands on /tmp/playwright-repl.sock; they show here as [server] lines.

Clients: pw-repl send -c <name> (or $PW_CLIENT) sends as a client of its own. It has a selected tab of
its own, so clients do not move each other's; its commands show as [server:<name>] lines. modes and tab
say which client turned each mode on and opened each tab, and modes off --mine turns off only the
sender's own. Senders without a name share the prompt's selected tab.

The prompt is pw[serve]> while the server is on and pw> without it. Before it are the modes on in the
selected tab, if any: (watch network:off routes:2 capture) pw>. modes lists them for every tab.

Times (requests, console, watch) are local, with their UTC offset: 18:16:15.721-06:00.

Dialogs are reported and never answered on their own; dialog answers one.`,
    commands: ['modes', 'dialog', 'help', 'quit'],
  },
};

const COMMANDS = {
  tab: {
    usage: 'tab [<index>|<url-part>|new [url]|close [url-part]]',
    summary: 'list tabs (* is selected); select, open or close one',
    detail: `tab <index> uses the numbers from your latest tab listing (each client has its own); they change
when tabs open or close.

tab <url-part> selects the one tab whose URL contains it, and refuses if none or several do.

tab new opens a tab behind the one in front, so it does not take the window from whoever is using it,
and selects it; tab shows who opened each tab opened this way. tab close closes the selected tab, or
the one matching url-part.

Closing the selected tab goes back to the previous tab if tab new opened it; otherwise no tab is
selected, and commands that need one refuse until one is.`,
  },
  goto: {
    usage: 'goto <url>',
    summary: 'navigate the selected tab',
    detail: `Without a scheme, http:// is assumed for localhost, 127.x and [::1], and https:// otherwise, as in
the address bar. tab new <url> reads its URL the same way.

A page that does not load says why, as wait load does: a failed request, after which the tab shows
Chrome's error page (info names the URL that failed), or an answer with no page (a 204), which
leaves the tab where it was. reload, back and forward say it the same way.`,
  },
  back: {
    usage: 'back',
    summary: 'go back one history entry',
    detail: `The browser may bring the page back from its back/forward cache, as it was: nothing loads or runs
again, so a loading message or a request the page makes on load does not come back. reload loads it
afresh.`,
  },
  forward: { usage: 'forward', summary: 'go forward one history entry', detail: `Like back, it may bring the page back from the back/forward cache without loading it again.` },
  reload: { usage: 'reload', summary: 'reload the selected tab' },
  info: { usage: 'info', summary: 'selected tab URL, title and viewport' },
  click: {
    usage: 'click <selector> [button]',
    summary: 'click the first match that can be clicked',
    detail: `After a ref or a quoted selector, a button (left, right, middle) may follow: click e5 right.
--modifiers=<key>[,<key>] holds keys down meanwhile (Alt, Control, ControlOrMeta, Meta, Shift).

When a selector matches several elements, hidden ones and ones covered by something else (a dialog's
overlay) are passed over, and it says which match it used: Clicked: text=Buy (match 3 of 4; ...). If
none can be clicked within 5s, it says why for each and does nothing. A ref, or a single match, is
clicked as it is, waiting up to 5s for it to be ready.

Timed out after it began acting, it says what stopped it (e.g. <div class="overlay"> intercepts
pointer events) and that the outcome is unknown; Playwright's full call log goes to the REPL's pane
or log.`,
  },
  dblclick: { usage: 'dblclick <selector> [button]', summary: 'double-click, choosing the match as click does' },
  hover: { usage: 'hover <selector>', summary: 'hover, choosing the match as click does' },
  mousemove: {
    usage: 'mousemove <x> <y>',
    summary: 'move the mouse to a point in the viewport',
    detail: `x and y are CSS pixels from the top left of the tab's viewport (not the page), as mouse events
have them. A snapshot has no coordinates; eval of getBoundingClientRect gives an element's centre:
eval (r => [r.x + r.width / 2, r.y + r.height / 2])(document.querySelector("#map")
  .getBoundingClientRect())

A click at a point: mousemove <x> <y>, mousedown, mouseup. A drag: mousedown, then mousemove to
another point, then mouseup.`,
  },
  mousedown: { usage: 'mousedown [button]', summary: 'press a mouse button where the mouse is (left, right or middle)' },
  mouseup: { usage: 'mouseup [button]', summary: 'release a mouse button where the mouse is' },
  mousewheel: {
    usage: 'mousewheel <dx> <dy>',
    summary: 'turn the wheel where the mouse is',
    detail: `Wheel events at the mouse's point (mousemove puts it there), in CSS pixels: positive dy scrolls
down. A map zooms around that point: mousemove 400 300, then mousewheel 0 -300 zooms in. It returns
once the events are sent, not once the page has scrolled or redrawn.`,
  },
  fill: {
    usage: 'fill <selector> <value> [--submit]',
    summary: 'clear an input and fill it',
    detail: `The selector is the first word; quote it if it has spaces. The rest of the line is the value, and
quotes around all of it are removed, so fill #name "" clears the field. --submit at the end presses
Enter in it afterwards.

Examples: fill #name Ada Lovelace, fill "text=Your name" Ada, fill e7 Ada`,
  },
  type: {
    usage: 'type [<selector>] <text> [--submit]',
    summary: 'type key by key after what the field holds; text as for fill',
    detail: `With one word, or one quoted, it is typed into the element that has focus: type "garden hose".
--submit at the end presses Enter afterwards.`,
  },
  press: { usage: 'press <key> | press <selector> <key>', summary: 'press a key (Enter, Escape, Control+A; any case), maybe on an element' },
  select: { usage: 'select <selector> <value>', summary: 'choose an option in a select (the value is the rest of the line)' },
  check: { usage: 'check <selector>', summary: 'check a checkbox' },
  uncheck: { usage: 'uncheck <selector>', summary: 'uncheck a checkbox' },
  upload: {
    usage: 'upload <selector> <file>...',
    summary: 'choose files in a file input, as the file picker would',
    detail: `The selector is a file input (even a hidden one), its label, or a button that opens the file
picker. The page then does what it does with a chosen file; often that is the upload itself.

The REPL reads the files and hands the page their contents, so they need not be where the browser
runs; up to 50MB in all. Relative paths are from the folder pw-repl send runs in, or the REPL's own
for a command typed at its prompt. Quote a path with spaces.`,
  },
  snapshot: {
    usage: 'snapshot [--full] [--grep <text> | <eN> | selector]',
    summary: 'outline by role and name, with [ref=eN] labels',
    detail: `Playwright's accessibility snapshot, with unnamed layout wrappers (generic) and cursor hints left
out; --full shows it unchanged.

--grep <text> prints only the lines containing text (role, name or flag such as [disabled], any
case), each with the named elements around it. A hit with no named element around it prints without
a path. A hit on text (a label) keeps the ref of the element holding it, so snapshot <that ref>
shows what sits beside it, such as the value next to the label. --regex <pattern> is --grep by a
regular expression: snapshot --regex "Total: \\d+".

An element with no role or name of its own (a card that is only a div) is left out, with its ref;
snapshot --full keeps it.

snapshot e3 outlines one element, and the refs of the last snapshot keep working. A ref (e3, or f1e3
in newer Playwright) works as a selector in any command: click e3. Refs can change when the page
changes (e102 may become f4e98), so take a new snapshot after it does. snapshot <selector> (not a
ref) gives new refs, and those from before stop working.

Output over 60 lines ends with a line count.`,
  },
  watch: {
    usage: 'watch on [--changes] [--live] | off | [n|new]',
    summary: 'record what happens in the tab; show the last n steps',
    detail: `Off until watch on; a watch on after watch off starts a new recording. Records clicks, typing (once
it pauses), Enter and Escape, form changes, submits and navigations, each described by role and name
like snapshot, with up to 5 of the requests it caused underneath, each with its status as in requests
(body <#> for one), leaving out scripts and what requests hides. The REPL's own fill is recorded
as type. A double-click shows as two clicks; hovering and moving the mouse are not recorded.

From its first watch on, a tab keeps response bodies of up to 100 KB, so body <#> still shows one
after the tab navigates, even when the page navigates as soon as the request answers.

watch on --next-tab [url-part] returns at once, then waits for the next tab someone opens (tab new,
a client's own, does not count), or the next whose URL contains url-part, and watches it from its
first page and selects it for the client that asked: for a tab someone is about to open. It takes
--changes and --live too; watch off stops waiting, and modes lists it. One tab is waited for at a time:
while one client waits, another's watch on --next-tab is refused, and its watch off leaves the wait on.

watch on its own says whether it is on and shows the last 20 steps; watch <n> shows the last n.
watch new shows only the steps it has not shown yet, and requests that have since arrived for the
last one.

--live also prints each step in the REPL window (never in the server's answer to a command) once it
settles, with its requests and changes, marked [watch], or [watch <url>] for a tab that is not the
selected one. A step cut short by the next one, or by watch off, prints at once; changes it made
then show under the next step.

--changes also shows what each step changed on the page once it settles, in up to 5 lines: + added,
- removed, ~ changed, each element once with the first names inside it. Not for navigations: what a
page changes on its own after a step settles (data arriving later) shows under the next step.

A watch belongs to the tab, not to a client: every client sees the same steps, watch new's place is
shared, and anyone's watch off stops it.

Typed values are not recorded, and password fields not at all; --changes leaves out field values,
but what the page itself shows (e.g. "Hello <name>") is shown. Nothing is replayed.`,
  },
  text: { usage: 'text [--all] <selector>', summary: 'visible text of the first match' },
  html: { usage: 'html [--all] <selector>', summary: 'outer HTML of the first match' },
  attrs: { usage: 'attrs [--all] <selector>', summary: 'attributes of the first match' },
  listeners: {
    usage: 'listeners <selector>|document|window',
    summary: 'the page\'s event listeners on an element',
    detail: `For the first match, one line each: the event, how it was added (capture, once, passive), the
start of the handler, where ↵ marks a line break, and its line in its script. --all shows each handler
whole, as written. Listeners added on a parent (e.g. document, for delegation) are not the element's
own: check listeners document too. Those Playwright adds to window as it acts are left out, and it
says how many.`,
  },
  count: { usage: 'count <selector>', summary: 'number of matches' },
  visible: { usage: 'visible <selector>', summary: 'whether the first match is visible' },
  links: { usage: 'links [--all]', summary: 'links on the page (text and href)' },
  inputs: { usage: 'inputs [--all]', summary: 'form controls on the page; values are omitted' },
  screenshot: {
    usage: 'screenshot [<ref>] [--full] [-d <secs>] [name]',
    summary: 'save a PNG of the viewport, --full page or an element',
    detail: `Saved as screenshot-<name or timestamp>.png in $PW_SCREENSHOT_DIR; without it, next to the REPL's
socket when it serves on one of its own, or else in /tmp. --filename=<file> saves it there instead (a
JPEG if it ends in .jpg), relative to the folder pw-repl send runs in; it never replaces a file.

screenshot e5 saves only that element, from a snapshot ref. --full-page is --full.

It brings the tab to the front of its window first: Chrome draws only the tab in front. The image
is at CSS pixel size, one image pixel per CSS pixel. While emulate mobile is on, it is what the
phone shows: a page laid out wider than the phone (no viewport meta tag) comes out shrunk to fit.

--delay counts down out loud first (maximum 60s), so someone can hold a hover or open a menu.`,
  },
  viewport: { usage: 'viewport [WxH]', summary: 'show or set the viewport size' },
  emulate: {
    usage: 'emulate [<what> [off] | off]',
    summary: 'emulate a phone, dark mode, a locale or a timezone',
    detail: `emulate mobile [device]  a phone's screen, touch and user agent: a Pixel 7, or a device named as in
                         Playwright's list, e.g. emulate mobile iPhone 13; a name that is not
                         exact lists the devices it matches (emulate mobile galaxy)
emulate dark | light     the color scheme the page's CSS and matchMedia see
emulate locale <tag>     the language (Accept-Language, navigator.language) and date and number
                         formats, e.g. fr-FR
emulate timezone <zone>  an IANA timezone, e.g. Asia/Tokyo
emulate <what> off       stop one (dark or light off stops the color scheme); emulate off stops all

Per tab, until turned off or the REPL exits. emulate on its own shows what is on.

The page sees the user agent, touch and navigator.languages from its next load: reload after
turning mobile or locale on or off. Dark, light and timezone apply at once, but what the page
already drew with them (times, colors set by its script) changes only when it reloads.

While mobile is on, viewport refuses: the device sets the size.`,
  },
  wait: {
    usage: 'wait [text|request] <what> [--gone] [secs]',
    summary: 'wait for an element, text, a response or a load (10s)',
    detail: `wait <selector> waits for a matching element to be visible, and wait text <text> for text to be;
wait request <url-part|glob> waits for a matching response, counting one that finished since the
previous command began, or is still under way (so click, then wait request, does not miss it).

wait load waits for the page to finish loading (its load event). A navigation that began since the
previous command began counts, so click a link, then wait load, waits for the new page. A page
that changes its own URL without loading (an app's own routing) is not a load: wait for something on
the new view instead.

wait text matches any part of an element's text, in any case.

--gone waits instead until nothing matching is visible (removed or hidden): wait .spinner --gone.
It is done at once if nothing matches yet, so wait for it to appear first if it may not have.

Up to 120s. A wait that times out is an error; the REPL carries on.`,
  },
  sleep: { usage: 'sleep <ms>', summary: 'wait a fixed time, in milliseconds (maximum 3600000)' },
  requests: {
    usage: 'requests [--all] [n] [url-filter]',
    summary: 'the selected tab\'s last n requests (default 20)',
    detail: `Recording starts when the REPL connects; the last 200 per tab are kept, of every kind the page
requests (not the browser's own, such as the favicon). Each line: #number, time, method, status (HTTP
code, pending, no response, failed: <reason>, <code>, then failed: <reason> when its body was cut
off, or <code> faked), duration, kind (document, fetch, xhr, script, image, ...), URL. A request that
finished a moment ago can still show pending.

n is how many of the latest to show (default 20). When more match, a first line says so: (last 20
of 112 kept; requests 112 shows them all). A page often makes more than 20 in one load. A line
"--- the page loads <url>" marks where each page load starts, even when a filter hides that request.

body <#> shows what a request got back.

Images, fonts, stylesheets, media and extension requests are hidden unless --all is given.

url-filter is a substring: requests 20 /api/ shows API calls only, e.g. when dev-server scripts
crowd the list. --regex <pattern>, at the end, matches URLs by a regular expression instead.`,
  },
  body: {
    usage: 'body [--all] <#>|<url-part>',
    summary: 'the response body of request <#>, or of the latest one matching',
    detail: `body <url-part> shows the latest finished request whose URL contains url-part (body slots.json).

Read from the browser on demand: JSON is pretty-printed, binary is not shown, output is capped. The
browser may drop a body (e.g. after the tab navigates); then body reports not available, unless a
watch kept it (help watch).

Bodies can contain sensitive data.`,
  },
  console: {
    usage: 'console [--all] [n] [level|filter]',
    summary: 'the last n console messages and page errors',
    detail: `Recording starts when the REPL connects; the last 200 per tab are kept. Each line: time, [type],
text. Types are console levels (log, warning, error, ...) and pageerror for uncaught exceptions. A
"--- the page loaded <url>" line marks each load after the first message shown.

A level (error, warning, info, debug) shows that level and those above it: console warning shows
warnings and errors, page errors among them. info, which leaves out debug, is what playwright-cli
shows by default. Anything else is a filter, matching part of the type or the text.

n is how many of the latest to show (default 20); when more match, a first line says so.

A page brought back from the back/forward cache (back, forward) reports its earlier messages again,
at the time it comes back, though nothing loaded again.`,
  },
  capture: {
    usage: 'capture on [requests|console] [secs] | off',
    summary: 'record requests and console together, in time order',
    detail: `capture on records both until capture off, which prints them; requests or console records only one.
With secs (1-3600 seconds) it records that long, then prints. Other commands wait until a timed
capture ends, so it suits recording what someone does in the browser; around your own commands, use
capture on and capture off.

One capture runs at a time, on the tab selected when it started. Unlike requests and console it
keeps more than the last 200 and lists both together.

capture on its own says whether one is running, or shows the last one.`,
  },
  route: {
    usage: 'route <glob> <how> | off <glob>|--all',
    summary: 'fake, patch, delay or fail the selected tab\'s matching requests',
    detail: `route <glob> <status> <json>  answer with this status (200-599) and JSON, or no body; it never
                              reaches the network, so it still answers while the network is off.
                              The body is the rest of the line. Another kind needs its type:
                              route <glob> 200 --content-type=text/plain hello
route <glob> patch <json>     let it through, then change its JSON response: a JSON Merge Patch, where
                              objects merge, null removes a key and anything else replaces; a
                              patch that is not an object (an array) replaces the whole body
route <glob> delay <secs>     hold it for up to 120 seconds, then let it through
route <glob> abort            fail it as if the connection broke

Each matching request prints a line (Faked:, Patched:, Delayed:, Aborted:) in the REPL window, and in
the answer to a command running then if that command's client has the tab selected, with its number as in requests (one the page makes after reload or
a click has answered shows only in the window: wait request <glob> waits for it); requests shows a fake
as <status> faked and a patch as <status> patched. If a route fails it prints "Route failed" and aborts
the request.

Routes belong to the tab and last until route off <glob> (or route off --all) or the REPL exits.
Routing the same glob again replaces it. route on its own lists the selected tab's routes. A glob may
be quoted.

Example: route **/api/cart patch {"total": 0}`,
  },
  network: {
    usage: 'network [on|off|slow [<ms> [<kbps>]]]',
    summary: 'cut, slow or restore the tab\'s network',
    detail: `network off cuts it, like dropped wifi. Stopping a service is not the same: a dev proxy in front of
it usually holds the request open, so the page spins instead of failing.

network slow makes each request take at least <ms> (Chrome's latency is a minimum, not added to a
slow server's own time) and limits its speed: by default as DevTools' Slow 4G (563ms, 1440 kbps
down, 675 up); network slow <ms> [<kbps>] sets them, kbps both ways (left out, it stays Slow
4G's). To slow one API, use route <glob> delay <secs>.

Per tab; lasts until network on or the REPL exits. Routes still answer while it is off or slow.`,
  },
  eval: {
    usage: 'eval [--all] <JavaScript>',
    summary: 'evaluate JavaScript in the selected tab and print the result',
    detail: `Promises are awaited, await works at the top level, and a function (() => document.title) is
called. eval <function> <ref> calls it with that element: eval "el => el.textContent" e5.

eval fetch(...) sends a new request, which can change state on the server; it cannot read one that
already happened (requests lists those).`,
  },
  cdp: {
    usage: 'cdp [--all] <method> <JSON object>',
    summary: 'send one CDP command through a temporary session',
    detail: `The session is detached afterwards, so subscriptions and settings do not persist.

Browser.close and Target.closeTarget are refused.`,
  },
  cookies: { usage: 'cookies [--all]', summary: 'cookie names, domains and flags; values are omitted' },
  storage: { usage: 'storage [--all]', summary: 'localStorage keys; values are omitted' },
  modes: {
    usage: 'modes [off [--mine]]',
    summary: 'the modes on in every tab; modes off turns them all off',
    detail: `The modes are watch, network off or slow, route, capture and emulate. Each is turned on and off with
its own command: watch on|off, network off|slow|on, route <glob> ... | route off <glob>|--all,
capture on|off, emulate ... | emulate off.

modes off turns off every one in every tab; a capture it stops is kept for capture to show. With
clients (help session), modes says which client turned each on, and modes off --mine turns off only
the sender's own.`,
  },
  dialog: {
    usage: 'dialog [accept [text] | dismiss]',
    summary: 'show, accept or dismiss an open alert, confirm or prompt',
    detail: `While a dialog is open, its page and the commands that read it wait. dialog runs at once, ahead
of them; it answers the selected tab's dialog, or the only one open. accept text answers a prompt.

With nobody at the browser (e.g. headless), it is the only way to answer one.`,
  },
  help: { usage: 'help [topic | command | --all]', summary: 'this help; --all prints every topic and command in full' },
  quit: {
    usage: 'quit',
    summary: 'disconnect, leaving Chromium running (one --launch started stops too)',
    detail: `Runs immediately, even while another command is waiting. Only available at the prompt.`,
  },
};

for (const topic of Object.values(TOPICS)) topic.intro = wrap(topic.intro);
for (const entry of Object.values(COMMANDS)) if (entry.detail) entry.detail = wrap(entry.detail);

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
  if (topicOrCommand === 'playwright-cli') {
    return wrap(`playwright-cli's command names, and what they run here (each says so the first time):

${require('./cli-names').table()}

Names both have (goto, click, fill, snapshot, eval, ...) take playwright-cli's forms too: click <ref>
[button] [--modifiers=<keys>], fill and type --submit, type <text> into what has focus, eval <function>
<ref>, press in any case, screenshot <ref> --full-page --filename=<file>, console <level>, requests
--static --filter=<regexp>, find --regex <regexp>, route <pattern> --status= --body= --content-type=.
Its other options are refused, never read as part of a selector or a value.

Different on purpose, since the browser may be someone else's too:
  routes, network and emulation     per tab, not the whole browser, so other people's tabs are untouched
  close                             turns off your modes; tabs stay open (tab close <url-part> closes one)
  upload <selector> <file>          names the input: file pickers are not caught, as a person's would be
  no snapshot after each command    a person reads the pane too; snapshot when you need one
  -s=<session>                      -c <name> is the nearest: a client with a selected tab of its own`);
  }
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

// pw-repl's own commands are run at the shell, so their help is the usage.
const SHELL_COMMANDS = new Set(['run', 'serve', 'send', 'attach', 'stop', 'where', 'skill']);

function notFound(topic) {
  if (SHELL_COMMANDS.has(topic)) return `${topic} is run at the shell (pw-repl ${topic}), not in the REPL; pw-repl --help has its options`;
  return `No help for ${topic}. Topics: ${Object.keys(TOPICS).join(', ')}`;
}

module.exports = { render, notFound, TOPICS, COMMANDS };
