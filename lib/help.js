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
The browser may be a shared session, with other users' tabs open in it.

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
  a video of what I do              help video
  break the backend on purpose      route <glob> <status> <json>, route <glob> abort, network off
  change or slow an API response    route <glob> patch <json>, route <glob> delay <secs>
  slow the whole network            network slow
  clean up                          modes off

Modes (watch, capture, record, route, network off or slow, emulate, viewport) stay on until turned off;
the prompt shows the selected tab's: (watch routes:1) pw>. tab, watch, capture, record, route, network,
emulate and modes on their own show their state and what you can run next.

Topics (help <topic>):
  tabs      open, select, close, navigate        network   requests, bodies, console, fakes, network off
  interact  click, fill, type, press, select     devtools  eval, CDP commands, cookie and storage names
  inspect   snapshot, watch, text, screenshots   session   modes, markers, server, quitting
  video     record a take, with a pointer

help <command> for usage and caveats (e.g. help route), help <command> --all for all of it; help --all
for everything.

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
    commands: ['snapshot', 'watch', 'text', 'html', 'attrs', 'listeners', 'count', 'visible', 'links', 'inputs', 'screenshot', 'highlight', 'viewport', 'emulate', 'wait', 'sleep'],
  },
  video: {
    intro: `A video of what you do in a tab, for someone to watch. Record it from a file of commands sent with
pw-repl send --file, not command by command: the time between commands sent one by one is in the video.

1. Set its size first: viewport 1280x720 (help viewport). Then try the flow without recording, and note
the selectors it needs (#id, text=..., role=...), not snapshot refs: the take starts again from a fresh
page, where the refs are stale.

2. Write the take, one command per line, then run it: pw-repl send --file take.txt (pw-repl help, outside
the REPL, has the rest). Its first line puts the page back as it was before the rehearsal (goto <url>),
so the take does not start from the rehearsal's end.

    goto https://shop.example/support/new
    record on clip.webm
    cursor on #subject
    type #subject Package arrived damaged
    select #area Shipping
    click #send
    wait text Ticket filed
    record off

3. While it records, pw-repl paces it for a viewer (help record): type types at a readable pace (use it,
not fill, for text the viewer should see typed), each action is followed by a pause, an element out of
view is scrolled to smoothly, and the video starts and ends on a still page. highlight <selector> draws a
box to point at something. After a step that loads a page, wait for text only the result shows (wait
text ...), not a heading the page always has, and not wait load: a single-page app loads nothing.

record on --steps also saves when and where each step ran, in the video's seconds and pixels, for
editing it afterwards.

The user's own screen, with their real pointer, takes a screen recorder they run (OBS, ffmpeg -f
x11grab, macOS screencapture -v): ask first. playwright-cli itself is a separate tool that records a
clean browser of its own (here, its video-start is record on).`,
    commands: ['record', 'cursor'],
  },
  network: {
    intro: `requests and console record all the time; a capture records only while it runs.`,
    commands: ['requests', 'body', 'console', 'capture', 'route', 'network'],
  },
  devtools: {
    intro: `Cookie and storage listings omit values. eval, cdp, html, screenshots, recordings and URLs can
still show sensitive data (cdp Network.getCookies shows cookie values).`,
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
sender's own. Senders without a name share the prompt's selected tab. Other clients' commands can run
between a client's own: its selected tab, and the previous command that wait request and wait load count
from, are its own; a tab's requests, console and watch are shared.

The prompt is pw[serve]> while the server is on and pw> without it. Before it are the modes on in the
selected tab, if any: (watch network:off routes:2 capture) pw>. modes lists them for every tab.

Times (requests, console, watch) are local, with their UTC offset: 18:16:15.721-06:00.

Dialogs are reported and never answered on their own; dialog accept or dismiss answers one, from any client, whoever opened it.`,
    commands: ['modes', 'dialog', 'help', 'quit'],
  },
};

const COMMANDS = {
  tab: {
    usage: 'tab [<index>|<url-part>|new [url]|close [url-part]]',
    summary: 'list tabs (* is selected); select, open or close one',
    args: [
      ['(none)', 'lists the tabs: * marks the selected one, and each says who opened it with tab new.'],
      ['<index>', 'selects by the number in your latest listing (each client has its own); numbers change when tabs open or close.'],
      ['<url-part>', 'selects the one tab whose URL contains it; refused if none or several do.'],
      ['new [url]', 'opens a tab behind the one in front, so it does not take the window from whoever is using it, and selects it. The URL is read as goto reads it.'],
      ['close [url-part]', 'closes the selected tab, or the one matching url-part.'],
    ],
    detail: `Closing the selected tab goes back to the previous tab if tab new opened it; otherwise no tab is
selected, and commands that need one refuse until one is.`,
  },
  goto: {
    usage: 'goto <url>',
    summary: 'navigate the selected tab',
    args: [
      ['<url>', 'without a scheme, http:// for localhost, 127.x and [::1], and https:// otherwise, as in the address bar.'],
    ],
    detail: `A page that does not load says why, as wait load does: a failed request, after which the tab shows
Chrome's error page (info names the URL that failed), or an answer with no page (a 204), which leaves
the tab where it was. tab new, reload, back and forward say it the same way.`,
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
    args: [
      ['<selector>', 'a Playwright selector or a snapshot ref (e5); quote one with spaces.'],
      ['[button]', 'left, right or middle, after a ref or a quoted selector: click e5 right. Default: left.'],
    ],
    options: [
      ['--modifiers=<keys>', 'keys held down meanwhile, comma-separated: Alt, Control, ControlOrMeta, Meta, Shift.'],
    ],
    detail: `Several matches: hidden ones and ones covered by something else (a dialog's overlay) are passed over,
and it says which it used: Clicked: text=Buy (match 3 of 4; ...). If none can be clicked within 5s, it
says why for each and does nothing. A ref, or a single match, is clicked as it is, waiting up to 5s for
it to be ready.

Timed out after it began acting, it says what stopped it (e.g. <div class="overlay"> intercepts pointer
events) and that the outcome is unknown; Playwright's full call log goes to the REPL's pane or log.`,
  },
  dblclick: { usage: 'dblclick <selector> [button]', summary: 'double-click, choosing the match as click does' },
  hover: { usage: 'hover <selector>', summary: 'hover, choosing the match as click does' },
  mousemove: {
    usage: 'mousemove <x> <y>',
    summary: 'move the mouse to a point in the viewport',
    args: [
      ['<x> <y>', 'CSS pixels from the top left of the tab\'s viewport (not the page), as mouse events have them.'],
    ],
    detail: `A snapshot has no coordinates; eval of getBoundingClientRect gives an element's centre:
eval (r => [r.x + r.width / 2, r.y + r.height / 2])(document.querySelector("#map")
  .getBoundingClientRect())

A click at a point: mousemove <x> <y>, mousedown, mouseup. A drag: mousedown, then mousemove to another
point, then mouseup.`,
  },
  mousedown: { usage: 'mousedown [button]', summary: 'press a mouse button where the mouse is (left, right or middle)' },
  mouseup: { usage: 'mouseup [button]', summary: 'release a mouse button where the mouse is' },
  mousewheel: {
    usage: 'mousewheel <dx> <dy>',
    summary: 'turn the wheel where the mouse is',
    args: [
      ['<dx> <dy>', 'CSS pixels; positive dy scrolls down.'],
    ],
    detail: `The events go to the mouse's point (mousemove puts it there): a map zooms around it, so mousemove 400
300, then mousewheel 0 -300 zooms in. It returns once the events are sent, not once the page has
scrolled or redrawn. While recording, it scrolls in eased steps over up to 1s (help record).`,
  },
  fill: {
    usage: 'fill <selector> <value> [--submit]',
    summary: 'clear an input and fill it',
    args: [
      ['<selector>', 'the first word; quote it if it has spaces: fill "text=Your name" Ada.'],
      ['<value>', 'the rest of the line; quotes around all of it are removed, so fill #name "" clears it.'],
    ],
    options: [
      ['--submit', 'at the end: presses Enter in it afterwards.'],
    ],
    detail: `Examples: fill #name Ada Lovelace, fill "text=Your name" Ada, fill e7 Ada. It sets the whole value at
once, even while recording: type shows it being typed.`,
  },
  type: {
    usage: 'type [<selector>] <text> [--submit]',
    summary: 'type key by key after what the field holds; text as for fill',
    args: [
      ['[<selector>]', 'as for fill. Without it (one word, or one quoted), into what has focus: type "garden hose".'],
      ['<text>', 'the rest of the line, as fill\'s value.'],
    ],
    options: [
      ['--delay=<ms>', 'right after type: the gap between keys. Default: none, or 60 while the tab records.'],
      ['--submit', 'at the end: presses Enter afterwards.'],
    ],
    detail: `While the tab is recording (help record), keys go 60ms apart, so the video shows the text being typed.
The whole text takes its length times the gap, and send waits 20s by default: about 300 characters at
60ms need a longer send -t, or a shorter --delay. --delay is a gap between keys, not a wait before
starting like screenshot's. A page that reacts to each key, such as search as you type, may react to
each one.

Date and time inputs: they take keys part by part, in the order they show them (10/02/2026 in en-US),
from the first part with a selector, or from the part a click landed on. type says what the input then
holds. Their ISO form (2026-10-02) is refused, since typed it comes out mangled: fill sets it.`,
  },
  press: { usage: 'press <key> | press <selector> <key>', summary: 'press a key (Enter, Escape, Control+A; any case), maybe on an element' },
  select: {
    usage: 'select <selector> <value>',
    summary: 'choose an option in a select (the value is the rest of the line)',
    args: [
      ['<value>', 'an option\'s value or its label.'],
    ],
    detail: `With the cursor on (help cursor), it also draws the select's list opening and the cursor choosing the
option, since a native select's list opens outside the page, where no screenshot or recording sees it;
the page gets the same input either way.`,
  },
  check: { usage: 'check <selector>', summary: 'check a checkbox' },
  uncheck: { usage: 'uncheck <selector>', summary: 'uncheck a checkbox' },
  upload: {
    usage: 'upload <selector> <file>...',
    summary: 'choose files in a file input, as the file picker would',
    args: [
      ['<selector>', 'a file input (even a hidden one), its label, or a button that opens the file picker.'],
      ['<file>...', 'one or more; quote one with spaces. Relative to the REPL\'s folder; through pw-repl send, the sender\'s.'],
    ],
    detail: `The page then does what it does with a chosen file; often that is the upload itself. The REPL reads
the files and hands the page their contents, so they need not be where the browser runs; up to 50MB in
all.`,
  },
  snapshot: {
    usage: 'snapshot [--full] [--grep <text> | <eN> | selector]',
    summary: 'outline by role and name, with [ref=eN] labels',
    args: [
      ['(none)', 'the whole page: Playwright\'s accessibility snapshot, with unnamed layout wrappers (generic), cursor hints and elements with no role or name of their own (a card that is only a div) left out.'],
      ['<eN>', 'outlines one element; the refs of the last snapshot keep working.'],
      ['<selector>', 'outlines the first match, with new refs: those from before stop working.'],
    ],
    options: [
      ['--full', 'Playwright\'s snapshot unchanged.'],
      ['--grep <text>', 'only the lines containing text (role, name or a flag such as [disabled], any case), each with the named elements around it.'],
      ['--regex <pattern>', '--grep by a regular expression: snapshot --regex "Total: \\d+".'],
    ],
    detail: `Refs: a ref (e3, or f1e3 in newer Playwright) works as a selector in any command: click e3. It belongs
to the tab whose snapshot gave it, and can change when the page changes (e102 may become f4e98): take a
new snapshot after it does.

--grep: a hit with no named element around it prints without a path. A hit on text (a label) keeps the
ref of the element holding it, so snapshot <that ref> shows what sits beside it, such as the value next
to the label.

Output over 60 lines ends with a line count.`,
  },
  watch: {
    usage: 'watch on [--changes] [--live] | off | [n|new]',
    summary: 'record what happens in the tab; show the last n steps',
    args: [
      ['on', 'starts recording the tab\'s steps; after watch off, a new recording.'],
      ['off', 'stops it; anyone\'s watch off stops it, since a watch belongs to the tab.'],
      ['(none) | <n>', 'says whether it is on, and shows the last 20 steps, or the last n.'],
      ['new', 'only the steps not shown yet, and requests that have since arrived for the last one.'],
    ],
    optionsFor: 'watch on',
    options: [
      ['--changes', 'also what each step changed on the page once it settled, in up to 5 lines: + added, - removed, ~ changed.'],
      ['--live', 'also prints each step in the REPL window once it settles (never in a command\'s answer), marked [watch], or [watch <url>] for a tab that is not the selected one.'],
      ['--next-tab [part]', 'returns at once, then watches the next tab someone opens, or the next whose URL contains part, from its first page, and selects it for you. tab new, a client\'s own, does not count.'],
    ],
    detail: `What a step is: a click, typing (once it pauses), Enter or Escape, a form change, a submit or a
navigation, described by role and name as in snapshot, with up to 5 of the requests it caused under it,
each with its status as in requests (body <#> for one), leaving out scripts and what requests hides. The
REPL's own fill shows as type. A double-click shows as two clicks; hovering and moving the mouse are not
recorded.

Privacy: typed values are not recorded, and password fields not at all; --changes leaves out field
values, but what the page itself shows (e.g. "Hello <name>") is shown. Nothing is replayed.

Shared: every client sees the same steps, and watch new's place is shared.`,
    moreAbout: 'bodies kept, --live timing, what --changes misses, and one --next-tab at a time',
    more: `From its first watch on, a tab keeps response bodies of up to 100 KB, so body <#> still shows one
after the tab navigates, even when the page navigates as soon as the request answers.

--live: a step cut short by the next one, or by watch off, prints at once; changes it made then show
under the next step.

--changes: each element once, with the first names inside it. Not for navigations: what a page changes
on its own after a step settles (data arriving later) shows under the next step.

--next-tab: it takes --changes and --live too; watch off stops waiting, and modes lists it. One tab is
waited for at a time: while one client waits, another's watch on --next-tab is refused, and its watch
off leaves the wait on.`,
  },
  text: { usage: 'text [--all] <selector>', summary: 'visible text of the first match' },
  html: { usage: 'html [--all] <selector>', summary: 'outer HTML of the first match' },
  attrs: { usage: 'attrs [--all] <selector>', summary: 'attributes of the first match' },
  listeners: {
    usage: 'listeners <selector>|document|window',
    summary: 'the page\'s event listeners on an element',
    options: [
      ['--all', 'each handler whole, as written.'],
    ],
    detail: `For the first match, one line each: the event, how it was added (capture, once, passive), the start
of the handler, where ↵ marks a line break, and its line in its script. Listeners added on a parent
(e.g. document, for delegation) are not the element's own: check listeners document too. Those
Playwright adds to window as it acts are left out, and it says how many.`,
  },
  count: { usage: 'count <selector>', summary: 'number of matches' },
  visible: { usage: 'visible <selector>', summary: 'whether the first match is visible' },
  links: { usage: 'links [--all]', summary: 'links on the page (text and href)' },
  inputs: { usage: 'inputs [--all]', summary: 'form controls on the page; values are omitted' },
  highlight: {
    usage: 'highlight [<selector> | off] [options]',
    summary: 'draw a box over elements, for the user or a screenshot',
    args: [
      ['<selector>', 'draws Playwright\'s highlight over every match, as playwright-cli\'s does: a tinted box that follows the element as the page scrolls or changes, and is in screenshots.'],
      ['(none)', 'lists the selected tab\'s highlights.'],
      ['off', 'hides them all, as highlight --hide does.'],
    ],
    options: [
      ['--style=<css>', 'CSS added to the box, quoted if it has spaces: highlight e5 --style="outline: 3px solid blue; border-radius: 50%" circles e5 in blue.'],
      ['--hide <selector>', 'hides one.'],
      ['--labels on|off', 'labels every box in the selected tab with its locator, as Playwright does, or not: those drawn already too. With a selector or on its own (highlight --labels on). Default: off.'],
    ],
    detail: `A highlight is a mode of its tab: modes shows it, modes off hides it, and the REPL hides every one as
it stops. Loading a new page drops them; a page that changes its route without loading keeps them.

The box is drawn over the page, in an element of Playwright's own added to it (x-pw-glass); the page's
own elements are not changed, and clicks and typing reach them as before.

Labels (--labels): Playwright labels each box with its locator, which covers what is just below it and
shows selectors in a screenshot or a video, so the REPL hides the labels unless they are on. On is a mode
of the tab, until --labels off or modes off. A box is labelled with the selector it was drawn from, e.g.
locator('role=button[name="Pay"]'); one drawn from a snapshot ref, with the locator Playwright makes for
its element, e.g. getByRole('button', { name: 'Pay' }), as the ref's own is not in the page's code.`,
    moreAbout: 'labels inside a frame, and when they cannot be hidden',
    more: `A highlight on an element inside an iframe is drawn in the frame's own document, and keeps its label.

The REPL hides the labels by reaching into Playwright's overlay, which a new Playwright could change: if
it cannot, it tells each client once, and the boxes are drawn with their labels.

For a screenshot without one then, eval can outline the element itself (with border-radius: 50% for a
circle). That changes the page, so put it back afterwards, as it was if it had a style of its own:
  eval document.querySelector("#rate-3").style.outline = "3px solid blue"
  eval document.querySelector("#rate-3").style.outline = ""`,
  },
  screenshot: {
    usage: 'screenshot [<ref>] [--full] [-d <secs>] [name]',
    summary: 'save a PNG of the viewport, --full page or an element',
    args: [
      ['[<ref>]', 'only that element, from a snapshot ref: screenshot e5.'],
      ['[name]', 'saved as screenshot-<name>.png; letters, digits, underscores and hyphens. Default: a timestamp.'],
    ],
    options: [
      ['--full', 'the whole page, not only the viewport; --full-page too.'],
      ['-d, --delay <secs>', 'counts down out loud first, up to 60, so someone can hold a hover or open a menu.'],
      ['--filename=<file>', 'saves it there instead (a JPEG if it ends in .jpg). Relative to the REPL\'s folder; through pw-repl send, the sender\'s. It never replaces a file.'],
    ],
    detail: `Where: $PW_SCREENSHOT_DIR; without it, next to the REPL's socket when it serves on one of its own, or
else in /tmp.

It brings the tab to the front of its window first: Chrome draws only the tab in front. The image is
at CSS pixel size, one image pixel per CSS pixel. While emulate mobile is on, it is what the phone
shows: a page laid out wider than the phone (no viewport meta tag) comes out shrunk to fit. An element bigger
than the viewport is taken with the page's scrollbar hidden for a moment, so that it does not move over.`,
  },
  cursor: {
    usage: 'cursor [on [<selector> | <x> <y>] | off]',
    summary: 'draw a pointer where the REPL acts, for videos',
    args: [
      ['on', 'fades it in where the mouse last went, or the middle.'],
      ['on <selector>', 'fades it in on the element (a video\'s first, say); when it is on already, glides it there. An element partly in view is pointed at where it shows, without scrolling, so one the page cuts off still looks cut off; one out of view is scrolled to.'],
      ['on <x> <y>', 'the same, at a point in the viewport.'],
      ['off', 'fades it out.'],
      ['(none)', 'says whether it is on, and where.'],
    ],
    detail: `The REPL's clicks and typing don't move a pointer on screen, so a recording shows things happening
with nothing pointing at them. With the cursor on, these commands move it smoothly to their element or
point before they act: click, dblclick, hover, fill, type <selector>, press <selector>, select, check,
uncheck, upload and mousemove. Each move takes 150 to 600ms by distance (300 to 1000ms while the tab
records), and the command waits for it. Clicks (click, dblclick, check, uncheck, mousedown, and upload
when it clicks a button) show a ring where they land.

Only the drawing moves: no mouse events are sent along the way, so the page gets the same input as with
the cursor off. It shows only the REPL's input, from every client, never the user's own mouse. fill,
select and the like move the drawing but leave the real mouse where it was; mousedown, mouseup and
mousewheel act at the real mouse, so the pointer moves back there first.

It is a mode of its tab: modes lists it and modes off turns it off. It stays on across page loads, at
the same spot, and shows in screenshots and recordings. Selectors, snapshot and text don't see it, it
takes no clicks, and it points at elements inside frames too.`,
  },
  record: {
    usage: 'record [on [file] [seconds] [options] | off [file]]',
    summary: 'record the selected tab\'s page to a video',
    args: [
      ['on | off', 'on starts recording the selected tab; off stops it, saves the file and says its path, length, size and bytes. Neither: says whether it is recording, and how your last recording ended.'],
      ['[file]', 'clip.webm or clip.mp4; its ending picks the format. Relative to the REPL\'s folder; through pw-repl send, the sender\'s. Default: recording-<timestamp>.webm where screenshot saves. On record off: saves it under that name instead.'],
      ['[seconds]', 'stops by itself after them, 1 to 3600. Default: 3600.'],
    ],
    optionsFor: 'record on',
    options: [
      ['--steps', 'also save clip.steps.txt next to clip.webm: when and where each command ran (Steps, below). Default: off.'],
      ['--pause=<ms>', 'a pause after each action, so the viewer sees what it did. Default: 750; 0 none.'],
      ['--lead=<ms>', 'still page recorded before record on returns. Default: 1000; counts toward the seconds.'],
      ['--tail=<ms>', 'still page recorded after record off, before it stops. Default: 1000; none when it stops at its seconds.'],
      ['--filename=<file>', 'the file, as playwright-cli writes it.'],
    ],
    detail: `What it records: the page only, from inside the browser, at the viewport's size in CSS pixels (set
it first: viewport 1280x720 fills a 16:9 player), with no pointer (cursor on draws one) and no toolbars. A hidden, background
or headless tab keeps recording. It brings the tab to the front first, as screenshot does. The file is
owner-only, as a screenshot is, and never replaces one. One recording per tab; another client with the
tab selected can stop it, and both are told whose it was.

While recording: type types at a pace the video can show (help type), mousewheel scrolls in eased steps,
an element out of view is scrolled to smoothly, each action is followed by --pause, and with the cursor
on it rests 300ms on the element before acting. fill still sets a value at once: use type for text the
viewer should see typed. Send the take as a file of commands (pw-repl send --file take.txt), or the time
between commands is in the video. help video has the whole way through.

Steps (--steps): one line per command run on the tab while it recorded: when it began and ended, in
seconds into the video, and the element or point it acted on, in the video's pixels. Use it to find a
moment in the video ("at 0:12 it clicked Save"), to add captions or cuts in an editor, or to check what
ran. It names the command and what it acted on, never what it typed or chose, the code it ran or a URL.
A (page) line marks each new page, loaded or routed to by a single-page app. It is renamed with the
video.

ffmpeg: $PW_FFMPEG, and only it when it is set (the REPL's, not send's); otherwise Playwright's own (npx
playwright-core install ffmpeg, in $PLAYWRIGHT_BROWSERS_PATH or ~/.cache/ms-playwright), then one on the
PATH. Playwright's writes only WebM; an MP4 needs a system ffmpeg with H.264. Without one that can write
the format, record on fails at once, recording nothing. WebM plays in browsers, GitHub, GitLab and Slack;
MP4 everywhere. About 15 MB a minute.`,
    moreAbout: 'an ffmpeg that exits mid-recording, a page that changes size, phones under emulate, and how a recording ended',
    more: `An ffmpeg that exits mid-recording ends the recording then; the pane says what was saved, and the
next record off fails with it. ffmpeg writes in blocks, so what it has not written yet is lost: the last
seconds, or at first all of it.

A page that changes size while recording is fitted into the first size, and the steps after it leave
out where they acted. Under viewport or emulate, a page the tab loads while recording holds the last
frame until the new page's HTML is in, and is then recorded at the viewport's size. Chrome sends a
frame as the page draws, and a still page keeps its real length. The size is made even (an odd width or
height loses a pixel), scrollbars included; a phone's under emulate mobile is its CSS size: a Pixel 7's
is 412 wide, less sharp than the phone draws it.

How it ended: record on its own, or record off when nothing is recording, says how your last recording
ended (record off, its seconds, its tab closing or the REPL stopping) with what record off would have
said. tab close says what became of a recording it ended. A REPL stopped with pw-repl stop cannot be
asked: stop prints what became of each recording it ended, and of one that ended by itself that record
has not shown since.

A name given to record off that does not end as its file does, or cannot be used, is refused, and it
goes on recording. There is no --mp4 or --webm: the file's ending picks the format.`,
  },
  viewport: {
    usage: 'viewport [WxH | off]',
    summary: 'show, set or unset the viewport size',
    args: [
      ['<W>x<H>', 'sets the selected tab\'s page to that size, until viewport off, modes off or the REPL exits. The window is not resized.'],
      ['off', 'back to the window\'s size.'],
      ['(none)', 'shows the size, and whether it was set or is the window\'s.'],
    ],
    detail: `emulate mobile sets a phone's size instead, and each refuses while the other is on.`,
  },
  emulate: {
    usage: 'emulate [<what> [off] | off]',
    summary: 'emulate a phone, dark mode, a locale or a timezone',
    args: [
      ['mobile [device]', 'a phone\'s screen, touch and user agent: a Pixel 7, or a device named as in Playwright\'s list, e.g. emulate mobile iPhone 13. A name that is not exact lists the devices it matches (emulate mobile galaxy).'],
      ['dark | light', 'the color scheme the page\'s CSS and matchMedia see.'],
      ['locale <tag>', 'the language (Accept-Language, navigator.language) and date and number formats, e.g. fr-FR.'],
      ['timezone <zone>', 'an IANA timezone, e.g. Asia/Tokyo.'],
      ['<what> off', 'stops one (dark or light off stops the color scheme).'],
      ['off', 'stops all.'],
      ['(none)', 'shows what is on.'],
    ],
    detail: `Per tab, until turned off or the REPL exits; emulate mobile <device> while another is on switches to
it. Mobile and viewport both set the screen size, so each refuses while the other is on: viewport off before
emulate mobile, and emulate mobile off before viewport.

The page sees the user agent, touch and navigator.languages from its next load: reload after turning
mobile or locale on or off. Touch means the page sees a touch screen; click still clicks with the
mouse, and sends no touch events. Dark, light and timezone apply at once, but what the page already
drew with them (times, colors set by its script) changes only when it reloads.`,
  },
  wait: {
    usage: 'wait [text|request] <what> [--gone] [secs]',
    summary: 'wait for an element, text, a response or a load (10s)',
    args: [
      ['<selector>', 'for a matching element to be visible.'],
      ['text <text>', 'for text to be visible: any part of an element\'s text, any case.'],
      ['request <part>', 'for a matching response (a URL part or a glob), counting one that finished since the previous command began, or is still under way: click, then wait request, does not miss it.'],
      ['load', 'for the page to finish loading (its load event), counting a navigation that began since the previous command began: click a link, then wait load.'],
      ['[secs]', 'how long, up to 120. Default: 10.'],
    ],
    options: [
      ['--gone', 'until nothing matching is visible (removed or hidden): wait .spinner --gone. Done at once if nothing matches yet, so wait for it to appear first if it may not have.'],
    ],
    detail: `A page that changes its own URL without loading (an app's own routing) is not a load: wait for
something on the new view instead. A wait that times out is an error; the REPL carries on.`,
  },
  sleep: {
    usage: 'sleep <ms>',
    summary: 'wait a fixed time, in milliseconds (maximum 3600000)',
    detail: `While recording, each action is already followed by a pause (help record): a sleep adds to it.`,
  },
  requests: {
    usage: 'requests [--all] [n] [url-filter]',
    summary: 'the selected tab\'s last n requests (default 20)',
    args: [
      ['[n]', 'how many of the latest to show. Default: 20. When more match, a first line says so: (last 20 of 112 kept; requests 112 shows them all).'],
      ['[url-filter]', 'a part of the URL: requests 20 /api/ shows API calls only.'],
    ],
    options: [
      ['--all', 'also images, fonts, stylesheets, media and extension requests, hidden otherwise.'],
      ['--regex <pattern>', 'at the end: matches URLs by a regular expression instead.'],
    ],
    detail: `Each line: #number, time, method, status (HTTP code, pending, no response, failed: <reason>, <code>
then failed: <reason> when its body was cut off, or <code> faked), duration, kind (document, fetch, xhr,
script, image, ...), URL. A line "--- the page loads <url>" marks where each page load starts, even when
a filter hides that request. body <#> shows what a request got back.

Kept: from when the REPL connects, and a tab opened since from its first page (one a link opens
included); the last 200 per tab, of every kind the page requests (not the browser's own, such as the
favicon). A page often makes more than 20 in one load. One that finished a moment ago can still show
pending.`,
  },
  body: {
    usage: 'body [--all] <#>|<url-part>',
    summary: 'the response body of request <#>, or of the latest one matching',
    args: [
      ['<#>', 'a request\'s number, from requests.'],
      ['<url-part>', 'the latest finished request whose URL contains it: body slots.json.'],
    ],
    options: [
      ['--all', 'the whole body, not capped.'],
    ],
    detail: `Read from the browser on demand: JSON is pretty-printed, binary is not shown. The browser may drop a
body (e.g. after the tab navigates); then body reports not available, unless a watch kept it (help
watch). Bodies can contain sensitive data.`,
  },
  console: {
    usage: 'console [--all] [n] [level|filter]',
    summary: 'the last n console messages and page errors',
    args: [
      ['[n]', 'how many of the latest to show. Default: 20; when more match, a first line says so.'],
      ['[level]', 'error, warning, info or debug: that level and those above it. console warning shows warnings and errors, page errors among them. info, which leaves out debug, is playwright-cli\'s default.'],
      ['[filter]', 'anything else: matches part of the type or the text.'],
    ],
    options: [
      ['--all', 'each message whole, not capped.'],
    ],
    detail: `Each line: time, [type], text. Types are console levels (log, warning, error, ...) and pageerror for
uncaught exceptions. A "--- the page loaded <url>" line marks each load after the first message shown.
Kept from when the REPL connects; the last 200 per tab.

A page brought back from the back/forward cache (back, forward) reports its earlier messages again, at
the time it comes back, though nothing loaded again.`,
  },
  capture: {
    usage: 'capture on [requests|console] [secs] | off',
    summary: 'record requests and console together, in time order',
    args: [
      ['on', 'records both until capture off, which prints them.'],
      ['requests | console', 'records only one.'],
      ['[secs]', 'records that long (1 to 3600), then prints. Other commands wait until it ends.'],
      ['(none)', 'says whether one is running, or shows the last one.'],
    ],
    detail: `A timed capture suits recording what someone does in the browser; around your own commands, use
capture on and capture off. One runs at a time, on the tab selected when it started. Unlike requests
and console it keeps more than the last 200, and lists both together.`,
  },
  route: {
    usage: 'route <glob> <how> | off <glob>|--all',
    summary: 'fake, patch, delay or fail the selected tab\'s matching requests',
    args: [
      ['<glob> <status> <json>', 'answers with this status (200-599) and JSON (the rest of the line), or no body. It never reaches the network, so it still answers while the network is off.'],
      ['<glob> patch <json>', 'lets it through, then changes its JSON response: a JSON Merge Patch, where objects merge, null removes a key and anything else replaces; one that is not an object (an array) replaces the whole body.'],
      ['<glob> delay <secs>', 'holds it for up to 120 seconds, then lets it through.'],
      ['<glob> abort', 'fails it as if the connection broke.'],
      ['off <glob> | --all', 'removes one route, or all.'],
      ['(none)', 'lists the selected tab\'s routes.'],
    ],
    options: [
      ['--content-type=<t>', 'the type of a body that is not JSON: route <glob> 200 --content-type=text/plain hello.'],
    ],
    detail: `Each matching request prints a line (Faked:, Patched:, Delayed:, Aborted:) with its number as in
requests: in the REPL window, and in the answer to a command running then if that command's client has
the tab selected. One the page makes after reload or a click has answered shows only in the window
(wait request <glob> waits for it). requests shows a fake as <status> faked and a patch as <status>
patched. A route that fails prints "Route failed" and aborts the request.

Routes belong to the tab and last until route off or the REPL exits. Routing the same glob again
replaces it. A glob may be quoted. Example: route **/api/cart patch {"total": 0}`,
  },
  network: {
    usage: 'network [on|off|slow [<ms> [<kbps>]]]',
    summary: 'cut, slow or restore the tab\'s network',
    args: [
      ['off', 'cuts it, like dropped wifi.'],
      ['slow [<ms> [<kbps>]]', 'each request takes at least <ms> (a minimum, not added to a slow server\'s own time), at <kbps> both ways. Default: DevTools\' Slow 4G: 563ms, 1440 kbps down, 675 up.'],
      ['on', 'restores it.'],
    ],
    detail: `Per tab; lasts until network on or the REPL exits. Routes still answer while it is off or slow. To slow
one API, use route <glob> delay <secs>. Stopping a service is not the same as network off: a dev proxy
in front of it usually holds the request open, so the page spins instead of failing.`,
  },
  eval: {
    usage: 'eval [--all] <JavaScript>',
    summary: 'evaluate JavaScript in the selected tab and print the result',
    args: [
      ['<JavaScript>', 'the rest of the line. Promises are awaited, await works at the top level, and a function (() => document.title) is called.'],
      ['<function> <ref>', 'calls it with that element: eval "el => el.textContent" e5.'],
    ],
    options: [
      ['--all', 'the whole result, not capped.'],
    ],
    detail: `eval fetch(...) sends a new request, which can change state on the server; it cannot read one that
already happened (requests lists those).`,
  },
  cdp: {
    usage: 'cdp [--all] <method> <JSON object>',
    summary: 'send one CDP command through a temporary session',
    args: [
      ['<method>', 'a CDP method: Network.getCookies.'],
      ['<JSON object>', 'its parameters: {} for none.'],
    ],
    options: [
      ['--all', 'the whole result, not capped.'],
    ],
    detail: `The session is detached afterwards, so subscriptions and settings do not persist. Browser.close and
Target.closeTarget are refused, and so is Page.handleJavaScriptDialog: dialog answers one.`,
  },
  cookies: {
    usage: 'cookies [--all]',
    summary: 'cookie names, domains and flags; values are omitted',
    detail: `--all lists every cookie, not capped. cdp Network.getCookies {} shows the values.`,
  },
  storage: {
    usage: 'storage [--all]',
    summary: 'localStorage keys; values are omitted',
    detail: `--all lists every key, not capped. eval localStorage.getItem("<key>") shows a value.`,
  },
  modes: {
    usage: 'modes [off [--mine]]',
    summary: 'the modes on in every tab; modes off turns them all off',
    args: [
      ['(none)', 'lists the modes on in every tab, and with clients (help session), which client turned each on.'],
      ['off', 'turns off every one in every tab; a capture it stops is kept for capture to show, and a recording it stops is saved, as record off would.'],
    ],
    options: [
      ['--mine', 'after off: only the sender\'s own.'],
    ],
    detail: `The modes, each turned on and off with its own command: watch on|off, network off|slow|on, route <glob>
... | route off <glob>|--all, capture on|off, record on|off, emulate ... | emulate off, viewport <WxH> |
viewport off, highlight <selector> | highlight off, cursor on|off.`,
  },
  dialog: {
    usage: 'dialog [accept [text] | dismiss]',
    summary: 'show, accept or dismiss an open alert, confirm or prompt',
    args: [
      ['(none)', 'lists the open dialogs; * marks the selected tab\'s.'],
      ['accept [text]', 'answers OK: text answers a prompt, and accept alone keeps its default, as OK in the browser does.'],
      ['dismiss', 'answers Cancel.'],
    ],
    detail: `It answers the selected tab's dialog, or the only one open, and runs at once, ahead of other commands.
While a dialog is open, its page and the commands that read it wait, a click that opened it included,
until it is answered. Commands run one at a time, so every client's commands behind that one wait too,
in any tab: in a shared REPL, answer a dialog you open.

An agent can answer any dialog, one it opened included; one the user answers in the browser is gone
from dialog then. cdp cannot answer one: Chrome lets only a session that saw it open do so. With nobody
at the browser (e.g. headless), it is the only way to answer one.`,
  },
  help: {
    usage: 'help [topic | command | --all]',
    summary: 'this help; --all prints every topic and command in full',
    args: [
      ['(none)', 'what this is, and the topics.'],
      ['<topic>', 'the topic, and one line per command in it.'],
      ['<command>', 'its usage, arguments, options and what most need to know.'],
      ['<command> --all', 'all of it, with what only goes wrong now and then.'],
      ['--all', 'every topic and command in full.'],
    ],
  },
  quit: {
    usage: 'quit',
    summary: 'disconnect, leaving Chromium running (one --launch started stops too)',
    detail: `Runs immediately, even while another command is waiting. Only available at the prompt.`,
  },
};

for (const topic of Object.values(TOPICS)) topic.intro = wrap(topic.intro);
for (const entry of Object.values(COMMANDS)) {
  if (entry.detail) entry.detail = wrap(entry.detail);
  if (entry.more) entry.more = wrap(entry.more);
}

// An Arguments or Options list: each name in a column of its own, its text wrapped beside it.
const NAME_WIDTH = 18;
function list(items, width = WIDTH) {
  return items.flatMap(([name, text]) => {
    const lines = wrap(text, width - NAME_WIDTH - 4).split('\n');
    const first = name.length <= NAME_WIDTH ? `  ${name.padEnd(NAME_WIDTH)}  ${lines.shift()}` : `  ${name}`;
    return [first, ...lines.map(l => `${' '.repeat(NAME_WIDTH + 4)}${l}`)];
  }).join('\n');
}

function commandLines(names) {
  const width = Math.max(...names.map(n => COMMANDS[n].usage.length));
  return names.map(n => `  ${COMMANDS[n].usage.padEnd(width)}  ${COMMANDS[n].summary}`);
}

// A command's help: usage and summary, its arguments and options, what most need to know, and, with
// full, the rest (what goes wrong rarely); without it, a line says where the rest is.
function commandBody(name, full) {
  const entry = COMMANDS[name];
  const parts = [];
  const lists = [];
  if (entry.args) lists.push(`Arguments:\n${list(entry.args)}`);
  if (entry.options) lists.push(`Options${entry.optionsFor ? ` (${entry.optionsFor})` : ''}:\n${list(entry.options)}`);
  if (lists.length) parts.push(lists.join('\n'));
  if (entry.detail) parts.push(entry.detail);
  if (entry.more) parts.push(full ? entry.more : wrap(`More, on ${entry.moreAbout}: help ${name} --all.`));
  return parts.join('\n\n');
}

function renderCommand(name, full = false) {
  const entry = COMMANDS[name];
  const body = commandBody(name, full);
  return [`${entry.usage} — ${entry.summary}`, ...(body ? ['', body] : [])].join('\n');
}

// Every topic's command list, with each command's details indented under it.
function renderAll() {
  const sections = Object.entries(TOPICS).map(([name, topic]) => {
    const lines = commandLines(topic.commands).flatMap((line, i) => {
      const body = commandBody(topic.commands[i], true);
      return body ? [line, ...body.split('\n').map(d => (d ? `      ${d}` : '')), ''] : [line];
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
  routes, network and emulation     per tab, not the whole browser, so other users' tabs are untouched
  close                             turns off your modes; tabs stay open (tab close <url-part> closes one)
  upload <selector> <file>          names the input: file pickers are not caught, as the user's would be
  no snapshot after each command    the user reads the pane too; snapshot when you need one
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
  const full = /^(\S+)\s+--all$/.exec(topicOrCommand);
  if (full && Object.hasOwn(COMMANDS, full[1])) return renderCommand(full[1], true);
  // A playwright-cli name: what it runs here, with that command's help.
  const cli = require('./cli-names').describe(topicOrCommand);
  if (cli?.nearest) return wrap(`${topicOrCommand} is playwright-cli's; ${cli.nearest}`);
  if (cli) {
    const here = cli.as.split(/\s/)[0];
    const intro = wrap(`${topicOrCommand} is playwright-cli's name for ${cli.as} here.`);
    return Object.hasOwn(COMMANDS, here) ? `${intro}\n\n${renderCommand(here)}` : intro;
  }
  return null;
}

// pw-repl's own commands are run at the shell, so their help is the usage.
const SHELL_COMMANDS = new Set(['run', 'serve', 'send', 'attach', 'stop', 'where', 'skill']);

function notFound(topic) {
  if (SHELL_COMMANDS.has(topic)) return `${topic} is run at the shell (pw-repl ${topic}), not in the REPL; pw-repl --help has its options`;
  return `No help for ${topic}. Topics: ${Object.keys(TOPICS).join(', ')}`;
}

module.exports = { render, notFound, TOPICS, COMMANDS };
