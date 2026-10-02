---
name: pw-repl
description: Inspect and drive a Chromium browser, possibly one a person is using, through the pw-repl (playwright-repl) REPL - tabs, page snapshots, clicks and typing, the mouse at a point (moves, buttons, wheel), requests and their bodies, console messages, waiting for pages and elements, choosing files, faking, patching or delaying responses, cutting or slowing the network, emulating a phone, dark mode, a locale or a timezone, recording what the person does, and recording a video of a tab. Use when asked to look at, debug or test something in a web page, in an existing Chromium with remote debugging or in one it starts itself.
allowed-tools: Bash(pw-repl:*) Bash(npx pw-repl@latest:*)
---

# pw-repl

<!-- pw-repl skill stamp -->

pw-repl (playwright-repl) is a REPL that drives a running Chromium over CDP. The browser may be a
shared session: a person can have their own tabs open in it and be using it while you work.

`pw-repl` below is the command the `pw-repl` npm package installs. Without a global install, use
`npx pw-repl@latest` in its place, in that same form for every command, so each one runs the same
version; from a clone, `<clone>/bin/pw-repl.js`.

`pw-repl where` also names the skill of the pw-repl you run: `skill: e5f6a7b8 (pw-repl 0.4.3)`. When
that is not the skill named at the top of this file, mention it to the user once, in passing, with
whatever else you are telling them, and carry on with the task:

- if this file's pw-repl version is newer than that one, pw-repl is behind: "🔄 pw-repl is older than
  this skill (pw-repl <that version>, skill from <this file's>); `npx pw-repl@latest` or
  `npm install -g pw-repl` updates it."
- otherwise, the skill is: "🔄 This pw-repl skill is out of date (from pw-repl <this file's version>;
  <that version> has a newer one). If you'd like me to update it, just ask: everything but its Custom
  rules section would be replaced." Update it only when the user asks for that; a yes to something else
  is not one. To update it, save what `pw-repl skill` prints over this file, with this file's Custom
  rules section in place of the new one's.

## Arguments

Freeform args describe what to do in the browser: a page to look at, a flow to try, a failure to
reproduce (e.g. `pw-repl find out why the cart total shows 0 after adding an item`). They are the task;
the sections below are how to carry it out. With no args, get a REPL running and ask what to do.

## Start it

`pw-repl where` says whether a REPL is running and how `send` reaches it, or that one is still starting
(retry shortly; it exits 64 until the REPL serves, as when none is running). Right after you start one,
for a moment before its process is up, it can still say none is there: retry for a few seconds before
taking that as a failed start. There are three ways to run one; each takes an optional start URL, which
opens in a new tab.

- `pw-repl serve --background` runs it detached, with a command server on `/tmp/playwright-repl.sock`
  (owner-only) and its output in `/tmp/playwright-repl.log`. `pw-repl attach` shows everything it does
  and takes commands; `pw-repl stop` stops it. It returns once the REPL serves; Ctrl-C before then gives
  up on the start, stops the REPL, exits 130, and says so in the log.
- `pw-repl serve` runs the same in a terminal, where the pane shows every command. Its prompt is
  `pw[serve]>`. It stops at that prompt (`quit`, or Ctrl-C); `pw-repl stop` is for a background one.
- Add `--launch` to `run` or `serve` (with or without `--background`) to have it start a Chromium of its
  own instead of connecting to one: headless unless `--headed`, in a temporary profile, on a free port of
  its own (never 9222). It stops with the REPL, Ctrl-C while it starts included, and `stop` returns once
  it has exited. It prints the command it ran; flags after `--` are passed to that Chromium, and a
  `--user-data-dir=<dir>` among them is used instead of the temporary profile, and kept. Started again in
  a kept profile, Chromium picks up where it left off, as it would for a person, headless too: its tabs
  come back, and session cookies with them, so a login stays. They start loading before the REPL is
  attached, so `requests` and `console` have only what came after, often nothing: `reload` for a full
  record.
- `pw-repl run` runs it in a terminal with no server; `send` then reaches it through tmux, if it runs in
  the tmux session `playwright-repl`:

  ```bash
  tmux send-keys -t playwright-repl -l 'pw-repl run'
  tmux send-keys -t playwright-repl Enter
  ```

A REPL of your own goes on a socket of its own, named with `-e` on every command, `serve` included:

```bash
pw-repl serve --background --launch -e /tmp/mine.sock
pw-repl send -e /tmp/mine.sock tab new http://localhost:3000
pw-repl stop -e /tmp/mine.sock
```

A socket file left by a REPL that died is replaced when the next one starts there. The log of a background REPL is next to its socket
(`/tmp/mine.log`), appended to run after run, with a line where each starts and stops (past 5 MB, a
start moves it to `/tmp/mine.log.1`); `tail -f` on it follows along without a terminal to attach from.
`serve <port>` listens on TCP 127.0.0.1 instead of a socket, with no access control.

### One REPL, many clients

One REPL serves everyone using its browser: the person at its prompt and any number of agents. When
`pw-repl where` finds one running for the browser you need, use it rather than start another, as a
client of your own: `PW_CLIENT=<name>` (or `send -c <name>`), with a name that says who you are.

- A client has its own selected tab, so clients do not move each other's. Its commands show in the pane
  as `[server:<name>]` lines.
- `modes` and `tab` say which client turned each mode on and opened each tab. `modes off --mine` turns
  off only what you turned on; `tab close <url-part>` closes a tab you opened.
- Commands run one at a time, from every client: a long one (`capture on 60`, `sleep`) holds the rest.

A REPL of your own, on a socket of its own, is for a browser of your own (`--launch`), or when you are
asked for one. Several REPLs on one browser each see every tab but list only their own modes, and can
undo each other's routes, network or emulation settings.

A REPL in a terminal stops at its prompt (`quit`, or Ctrl-C); `send quit` is refused.

## Send commands

```bash
pw-repl send tab
pw-repl send -t 90 'screenshot -d 60'   # wait longer than the 20s default
```

Always send commands with `pw-repl send`; don't type into the pane yourself, except `quit` at the prompt
of a REPL of your own, which `send` refuses. The words after `send` are the command. For `fill`, `type`,
`select`, `press` and `upload`, a word quoted in your shell stays one word
(`pw-repl send fill "text=Your name" Ada`); other commands get the words as they are, joined by spaces
(`pw-repl send eval "document.title + ' x'"`). A command that takes only a selector takes the whole line,
spaces and all: `pw-repl send click "text=Your name"`. It works however the REPL was started:

- `run` (in tmux): `send` types the command into the tmux pane and reads the result back off the screen.
  It types only when the pane's last line is a bare prompt, so nothing lands in a shell or in the middle
  of what someone is typing; while a command is running, someone is typing, or the REPL is exiting, it
  refuses (exit 64). Wait and retry.
- `serve`, in a terminal or in the background: `send` sends it over the socket and gets the output back
  as JSON. Same commands, more reliable results: nothing is scraped, long output isn't cut off by
  scrollback, and a command can never land in a shell.

`pw-repl where` says which one a command would reach (the server, or the tmux pane running the
REPL), or why neither is reachable, without running anything.

`send --file take.txt` runs a file of commands, one per line, as typed at the prompt (no shell quoting;
files relative to your folder, as on `send`'s command line; `#` comments), and stops at the first that fails, saying which line.
It is the way to record a video without gaps (`help record`), and to keep a repro to run again.

`send` takes one command; chain several in your shell. Use `&&` when a step only makes sense if the one
before it worked: it stops at any exit status but 0, a failure and an outcome not confirmed included.
Use `;` when the steps do not depend on each other. `-t` is each command's own limit. Write each
`pw-repl send` out in full, not in a shell variable, which hides it from permission rules that allow
`pw-repl` commands:

```bash
pw-repl send -c cart-bug click e5 && pw-repl send -c cart-bug wait load &&
  pw-repl send -c cart-bug screenshot
pw-repl send -c cart-bug count .item; pw-repl send -c cart-bug text h1
```

Other clients' commands can run between yours. Your selected tab is your own, and so is the previous
command that `wait request` and `wait load` count from; a tab's requests, console and watch are shared
with whoever else uses that tab.

Every command you run and its output show in the REPL's pane, or in `attach` and the log for a
background REPL (server commands as `[server]` lines), so whoever looks there sees what you do. The pane
shows REPL commands only, not what was clicked in the browser (unless `watch on --live` is on); for
that, look at the browser itself: `tab` and `info` for where things are, `requests` for the requests the
clicks made (`body <#>` for what one returned), `console` for console messages and page errors. `watch
on` records each step someone takes in a tab, with the requests it caused (`watch on --changes` adds
what each step changed on the page); `watch` reads it back, and `watch new` only what it has not shown
yet. For a tab they have not opened yet, `watch on --next-tab [url-part]` waits for it and watches it
from its first page.

When watching someone:

- A watched tab keeps response bodies of up to 100 KB, so `body <#>` still has them after the tab
  navigates. Read a bigger one that matters as soon as it shows up in `requests`: the browser drops it
  once the tab navigates.
- `watch` leaves out images and other static files, failed ones too; `console error` and
  `requests --all` show what failed.
- Without a url-part, `--next-tab` takes the first tab anyone opens; check `tab` and `info` once it
  fires, since another tab opening later does not show in `watch`.
- A watch belongs to the tab: when another client watches it too, read it with `watch <n>`, since
  `watch new`'s place is shared and each one's would hide steps from the other.

Exit status: `0` ok, `1` the command failed, `2` completion not confirmed (outcome unknown: do not
blindly retry a change), `64` usage or the REPL is not reachable. `pw-repl --help` has the options.

## Learn the commands

Run `pw-repl send help`. It lists seven topics; `help <topic>` lists their commands, `help <command>`
gives usage and caveats, and `help --all` prints everything at once. pw-repl answers it itself: it needs
no running REPL, and never reaches one. The
help is the command reference; this file does not repeat it. If you know playwright-cli, its command
names work too (`help playwright-cli` lists them).

### Coming from playwright-cli

Its command names and most of their options work, and each says the first time what it is here. What
differs comes from the browser being shared. With `<name>` a client name of your own, e.g. from your
task (`cart-bug`), since two agents with one name are one client:

```bash
pw-repl send -c <name> open http://localhost:3000   # a tab of your own in the shared browser
pw-repl send -c <name> snapshot                     # no snapshot after each command; ask for one
pw-repl send -c <name> click e5
pw-repl send -c <name> close                        # your modes off; tab close <url-part> closes your tab
```

- There is no browser of your own to open or close: `open` opens a tab in the one the REPL uses, and
  `close` turns off the modes you turned on and leaves every tab open.
- Instead of `-s=<session>`, send as a client: `-c <name>`, with a selected tab of its own, in a browser
  whose cookies and storage are shared.
- `upload <selector> <file>` names the file input or the button that opens it; do not click a file
  input first, since the file picker is not caught.
- Routes, network and emulation apply to one tab, not to the whole browser.

## Sharing the browser

- The browser may have tabs that are not yours, and someone may be using it. Whether to read or act in
  one of those tabs, or to open your own (`tab new <url>`), depends on the task; when that is not
  clear, ask.
- No tab is selected when the REPL starts. A start URL's tab, marked `(the start URL)` in `tab`, is
  selected at its prompt and for `send` without a client name; a named client (`-c`) selects it with
  `tab <index>`. Closing a tab the REPL opened goes back to the tab before it, if the REPL opened that
  one too; otherwise no tab is selected.
  Tab numbers change when tabs open or close; `tab <url-part>` and `tab close <url-part>` pick a tab by
  its URL and refuse if it is ambiguous.
- You can answer any dialog yourself, one you opened included: `dialog` shows it, and `dialog accept`
  or `dialog dismiss` answers it. Nothing answers one on its own, and while one is open its page and
  the commands that read it wait. One answered in the browser is gone from `dialog` too.
- Modes and tabs stay on or open until they are turned off or closed, whoever started them. `modes`
  lists what is on in every tab (the prompt shows the selected tab's, e.g. `(watch routes:1) pw>`);
  `modes off` turns off every mode in every tab.
- Someone may be attached to the REPL's tmux session; killing the session ends it for them too.
- To point something out, to the person or in a screenshot, `highlight <ref|selector>` draws a box over it
  without changing the page (`--style=<css>` restyles it; `highlight off` hides them). Its label can
  cover what is below it; `help highlight` says how to mark a screenshot without one.
- For a video, `help video` says how: a take written as a file and sent with `send --file`, `record on`
  around it, `cursor on` for a pointer, and the pacing recording adds for the viewer; a screen recorder on
  the user's machine records what they see.

## Environment

- Chromium must be running with `--remote-debugging-port=9222`, unless `--launch` starts one. A headless
  one works too (`--headless=new`); nobody answers its dialogs but `dialog`.
- `PW_CHROME` — the Chromium `--launch` starts (default: Playwright's own, then one on the `PATH`).
- `PW_FFMPEG` — the ffmpeg `record` uses, and no other, read by the REPL, not by `send` (default:
  Playwright's own, then one on the `PATH`).
- Playwright's own Chromium and ffmpeg are found where Playwright installs them: `PLAYWRIGHT_BROWSERS_PATH`,
  or `~/.cache/ms-playwright`.
- `PW_CDP_URL` — CDP endpoint (default `http://localhost:9222`).
- `PW_SCREENSHOT_DIR` — where the REPL saves screenshots, read when it starts, not by `send`. Without it,
  a REPL on a socket of its own saves them next to its socket, and any other in `/tmp`. `screenshot`
  prints each file's path; other REPLs may save theirs in the same place. Remove only your
  own, and keep those too if they are needed, e.g. as evidence or as something to hand over.
- `PW_ENDPOINT` / `PW_TMUX_SESSION` — defaults for `send -e` / `-s`. `PW_SOCKET` — the socket `serve`
  serves on and `send` looks for when neither is given (default `/tmp/playwright-repl.sock`).

## Custom rules

No custom rules have been added yet.
