# Agent Instructions — playwright-repl

A REPL that drives a running Chromium over CDP. The browser may be a shared session: a person can
have their own tabs open in it and be using it while you work.

`pw-repl` below is the command this package installs. In a clone without a global install, use
`<this repo>/bin/pw-repl.js` (the folder this file is in); it behaves the same.

## Start it

The REPL runs in the tmux session `playwright-repl`. Check it first:

```bash
tmux capture-pane -t playwright-repl -p -S -5
```

If the pane is at a shell prompt, start the REPL there. If there is no session, ask the user before
creating one.

```bash
tmux send-keys -t playwright-repl -l 'pw-repl run'
tmux send-keys -t playwright-repl Enter
```

`pw-repl serve` is the same plus a command server on `/tmp/playwright-repl.sock` (owner-only); its
prompt is `pw[serve]>` instead of `pw>`. It is opt-in: use it when the user asks for it or agrees.
Prefer the socket: `pw-repl serve <port>` (TCP on 127.0.0.1) has no authentication, so any local
process could drive the browser; use it only for a client that cannot reach the socket. Both take an
optional start URL, which navigates tab [0]. Stop either at the pane (`quit`, or Ctrl-C); `send quit` is
refused so an agent cannot close a REPL the user is using.

## Send commands

```bash
pw-repl send tabs
pw-repl send -t 90 'screenshot -d 60'   # wait longer than the 20s default
```

Always send commands with `pw-repl send`; don't type into the pane yourself. Unquoted words are one
command. It works however the REPL was started:

- `run`: `send` types the command into the tmux pane and reads the result back off the screen. It
  types only when the pane's last line is a bare prompt, so nothing lands in a shell or in the middle
  of what the user is typing; while a command is running, the user is typing, or the REPL is exiting,
  it refuses (exit 64). Wait and retry.
- `serve`: `send` sends it over the socket and gets the output back as JSON. Same commands, more
  reliable results: nothing is scraped, long output isn't cut off by scrollback, and a command can
  never land in a shell. If you'll send many commands or read long output, ask the user whether to
  restart the REPL with `pw-repl serve`.

`pw-repl where` says which one a command would reach (the server, or the tmux pane running the
REPL), or why neither is reachable, without running anything.

Either way, every command you run and its output show in the pane (server commands as `[server]`
lines), so the user sees what you do. The pane shows REPL commands only, not what the user clicked in
the browser; for that, look at the browser itself: `tabs` and `url` for where they are, `recent` for the
requests their clicks made (`body <#>` for what one returned), `logs` for console messages and page errors.
When the user wants to show you what they do, `watch on` on their tab records each step with the
requests it caused (`watch on --changes` adds what each step changed on the page); `watch` reads it
back, and `watch new` only what you have not read yet. Watching and reading are fine on the user's
tabs; the rule below is about acting on them.

Exit status: `0` ok, `1` the command failed, `2` completion not confirmed (outcome unknown: do not
blindly retry a change), `64` usage or the REPL is not reachable. `pw-repl --help` has the options.

## Learn the commands

Run `pw-repl help`. It lists six topics; `help <topic>` lists their commands, `help <command>` gives
usage and caveats, and `help --all` prints everything at once. It needs no running REPL. The help is
the command reference; this file does not repeat it.

## Shared-browser rules

- Act only on tabs you opened (`tab new`), unless the user asks you to act on theirs (e.g. a `route` in
  their tab while they test); then say what you are doing and undo it the moment you are done. The REPL
  selects tab [0] at startup, and that tab may be the user's: run `tab` before acting. Closing your
  tab goes back only to a tab you opened; otherwise no tab is selected. Tab numbers change when tabs
  open or close; `tab <url-part>` and `tab close <url-part>` pick a tab by its URL and refuse if it is
  ambiguous.
- Dialogs are never answered automatically. The person at the browser handles them.
- Before leaving: `unroute --all`, `offline off`, `watch off`, and close the tabs you opened.
- The tmux session may be attached by the user. Never kill it.

## Environment

- Chromium must be running with `--remote-debugging-port=9222`.
- `PW_CDP_URL` — CDP endpoint (default `http://localhost:9222`).
- `PW_SCREENSHOT_DIR` — where screenshots go (default `/tmp`). They are all named `screenshot-*.png`,
  so `rm /tmp/screenshot-*.png` cleans up.
- `PW_ENDPOINT` / `PW_TMUX_SESSION` — defaults for `send -e` / `-s`. `PW_SOCKET` — the socket `send`
  looks for when neither is given (default `/tmp/playwright-repl.sock`).

## Contributing

If you hit a limitation or write a workaround, consider adding the capability to the REPL instead.

- A command is a function in the `commands` object in `lib/commands.js`, plus an entry in `lib/help.js`
  under one topic.
- `bin/pw-repl.js` is the command line; `lib/start.js` connects and runs the prompt; `lib/runner.js`
  runs commands one at a time; `lib/server.js` is the opt-in server; `lib/send.js` and `lib/client.js`
  are `send` and `where`; `lib/output.js` routes all output so the server can return it.
- Comment the *why* when it isn't obvious from the code.
- `npm test` runs the suite (about 10s): a private headless Chromium, a local test site, and the real
  REPL with its server. Nothing is mocked, and the shared browser is never touched. It finds Chromium
  through `PW_TEST_CHROME` or Playwright's installed browsers, and skips the browser tests if there is
  none. Add a test with each new command or behaviour.
- For anything the tests can't reach, exercise the change in a running REPL. Use your own tmux session
  and a new tab, not the user's.
