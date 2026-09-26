---
name: pw-repl
description: Inspect and drive a Chromium browser, possibly one a person is using, through the pw-repl (playwright-repl) REPL - tabs, page snapshots, clicks and typing, requests and their bodies, console messages, waiting for pages and elements, choosing files, faking, patching or delaying responses, cutting or slowing the network, and recording what the person does. Use when asked to look at, debug or test something in a web page, in an existing Chromium with remote debugging or in one it starts itself.
---

# pw-repl

pw-repl (playwright-repl) is a REPL that drives a running Chromium over CDP. The browser may be a
shared session: a person can have their own tabs open in it and be using it while you work.

`pw-repl` below is the command the `pw-repl` npm package installs. Without a global install,
`npx pw-repl` works the same; from a clone, `<clone>/bin/pw-repl.js`.

## Arguments

Freeform args describe what to do in the browser: a page to look at, a flow to try, a failure to
reproduce (e.g. `pw-repl find out why the cart total shows 0 after adding an item`). They are the task;
the sections below are how to carry it out. With no args, get a REPL running and ask what to do.

## Start it

`pw-repl where` says whether a REPL is running and how `send` reaches it. There are three ways to run
one; each takes an optional start URL, which opens in a new tab.

- `pw-repl serve --background` runs it detached, with a command server on `/tmp/playwright-repl.sock`
  (owner-only) and its output in `/tmp/playwright-repl.log`. `pw-repl attach` shows everything it does
  and takes commands; `pw-repl stop` stops it.
- `pw-repl serve` runs the same in a terminal, where the pane shows every command. Its prompt is
  `pw[serve]>`.
- Add `--launch` to `run` or `serve` (with or without `--background`) to have it start a Chromium of its
  own instead of connecting to one: headless unless `--headed`, in a temporary profile, stopped with the
  REPL. It prints the command it ran; flags after `--` are passed to that Chromium.
- `pw-repl run` runs it in a terminal with no server; `send` then reaches it through tmux, if it runs in
  the tmux session `playwright-repl`:

  ```bash
  tmux send-keys -t playwright-repl -l 'pw-repl run'
  tmux send-keys -t playwright-repl Enter
  ```

`serve` and `serve --background` take a socket path of your own instead of the default
(`pw-repl serve --background /tmp/mine.sock`); `send`, `attach`, `stop` and `where` then need
`-e /tmp/mine.sock`, or `PW_SOCKET=/tmp/mine.sock`. The log of a background REPL is next to its socket
(`/tmp/mine.log`); `tail -f` on it follows along without a terminal to attach from. `serve <port>`
listens on TCP 127.0.0.1 instead of a socket, with no access control.

Several REPLs can run at once, each on its own socket, e.g. one per agent. Each has its own selected tab,
command queue and modes, so they do not wait on or select for each other. They share the browser,
though: each sees every tab, `modes` lists only its own REPL's modes, and two REPLs acting on the same
tab can undo each other's routes or network setting.

A REPL in a terminal stops at its prompt (`quit`, or Ctrl-C); `send quit` is refused.

## Send commands

```bash
pw-repl send tab
pw-repl send -t 90 'screenshot -d 60'   # wait longer than the 20s default
```

Always send commands with `pw-repl send`; don't type into the pane yourself. The words after `send`
are the command. For `fill`, `type`, `select` and `press`, a word quoted in your shell stays one word
(`pw-repl send fill "text=Your name" Ada`); other commands get the words as they are
(`pw-repl send eval "document.title + ' x'"`). It works however the REPL was started:

- `run` (in tmux): `send` types the command into the tmux pane and reads the result back off the screen.
  It types only when the pane's last line is a bare prompt, so nothing lands in a shell or in the middle
  of what someone is typing; while a command is running, someone is typing, or the REPL is exiting, it
  refuses (exit 64). Wait and retry.
- `serve`, in a terminal or in the background: `send` sends it over the socket and gets the output back
  as JSON. Same commands, more reliable results: nothing is scraped, long output isn't cut off by
  scrollback, and a command can never land in a shell.

`pw-repl where` says which one a command would reach (the server, or the tmux pane running the
REPL), or why neither is reachable, without running anything.

Every command you run and its output show in the REPL's pane, or in `attach` and the log for a
background REPL (server commands as `[server]` lines), so whoever looks there sees what you do. The pane
shows REPL commands only, not what was clicked in the browser (unless `watch on --live` is on); for
that, look at the browser itself: `tab` and `info` for where things are, `requests` for the requests the
clicks made (`body <#>` for what one returned), `console` for console messages and page errors. `watch
on` records each step someone takes in a tab, with the requests it caused (`watch on --changes` adds
what each step changed on the page); `watch` reads it back, and `watch new` only what it has not shown
yet.

Exit status: `0` ok, `1` the command failed, `2` completion not confirmed (outcome unknown: do not
blindly retry a change), `64` usage or the REPL is not reachable. `pw-repl --help` has the options.

## Learn the commands

Run `pw-repl send help`. It lists six topics; `help <topic>` lists their commands, `help <command>`
gives usage and caveats, and `help --all` prints everything at once. It needs no running REPL. The
help is the command reference; this file does not repeat it.

## Sharing the browser

- The browser may have tabs that are not yours, and someone may be using it. Whether to read or act in
  one of those tabs, or to open your own (`tab new <url>`), depends on the task; when that is not
  clear, ask.
- No tab is selected when the REPL starts (unless it was given a start URL). Closing a tab the REPL
  opened goes back to the tab before it, if the REPL opened that one too; otherwise no tab is selected.
  Tab numbers change when tabs open or close; `tab <url-part>` and `tab close <url-part>` pick a tab by
  its URL and refuse if it is ambiguous.
- Dialogs are never answered on their own. While one is open, its page and the commands that read it
  wait; `dialog` shows it, and `dialog accept` or `dialog dismiss` answers it.
- Modes and tabs stay on or open until they are turned off or closed, whoever started them. `modes`
  lists what is on in every tab (the prompt shows the selected tab's, e.g. `(watch routes:1) pw>`);
  `modes off` turns off every mode in every tab.
- Someone may be attached to the REPL's tmux session; killing the session ends it for them too.

## Environment

- Chromium must be running with `--remote-debugging-port=9222`, unless `--launch` starts one. A headless
  one works too (`--headless=new`); nobody answers its dialogs but `dialog`.
- `PW_CHROME` — the Chromium `--launch` starts (default: Playwright's own, then one on the `PATH`).
- `PW_CDP_URL` — CDP endpoint (default `http://localhost:9222`).
- `PW_SCREENSHOT_DIR` — where screenshots go (default `/tmp`). They are all named `screenshot-*.png`,
  so `rm /tmp/screenshot-*.png` cleans up.
- `PW_ENDPOINT` / `PW_TMUX_SESSION` — defaults for `send -e` / `-s`. `PW_SOCKET` — the socket `send`
  looks for when neither is given (default `/tmp/playwright-repl.sock`).

## Custom rules

No custom rules have been added yet.
