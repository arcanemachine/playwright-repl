# playwright-repl

A command REPL for a Chromium you are already using, shared by you and your agents. It connects over CDP
through Playwright; people click in the browser and type at the prompt, agents send the same commands,
and every command shows in the REPL, so each sees what the other does.

## Why use it

For working on a web page together with an agent, in the browser you already use:

- **Your browser, as it is.** It connects to a running Chromium, with your tabs, sign-ins and state, and
  leaves it running when it stops; nothing is reset to a fresh profile.
- **One session, seen by everyone.** You and any number of agents drive the same browser, each with a
  selected tab of its own, and every command shows in the REPL, whoever sent it.
- **What you did, for an agent to read.** `watch` records each step you take in a tab, with the requests
  it caused, so you can reproduce a bug by hand and the agent can see exactly what happened.
- **Breaking things on purpose.** Fake, patch, delay or fail responses, cut or slow the network, emulate a
  phone, a locale or a timezone, all per tab, so your other tabs are left alone.

Coming from Microsoft's playwright-cli? See [How it differs](#how-it-differs-from-playwright-cli).

## Quick start

Needs Node.js 20 or newer and a Chromium-based browser (Chrome, Chromium, ...). With none installed,
`npx playwright-core install chromium` downloads Playwright's.

```bash
npx pw-repl@latest run --launch https://example.com
```

`--launch` starts a private headless Chromium for the REPL, and stops it with the REPL; it prints the
command it ran. `--headed` shows that browser, to click in it yourself. The page opens in a new tab,
and a `pw>` prompt waits:

```text
pw> help                          # common tasks and topics; help <topic>, help <command>, help --all
pw> snapshot                      # the page by role and name, with [ref=eN] labels
pw> click e3                      # click by snapshot ref (or any Playwright selector)
pw> requests                      # requests the tab made
pw> quit
```

Commands act on the selected tab (`tab` lists the tabs, with `*` on the selected one).

Without installing, use `npx pw-repl@latest <command>` in the same form every time, so each command runs
the same version. Installed: `npm install -g pw-repl`, then `pw-repl <command>`. From a clone:
`npm install`, then `bin/pw-repl.js <command>` (or `npm link` to get `pw-repl`).

## Use your own browser

Start it with remote debugging, then run the REPL without `--launch`:

```bash
chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/chrome-debug"
pw-repl run              # connects to localhost:9222; pw-repl on its own shows the usage
```

Use a separate `--user-data-dir`: recent Chrome versions do not open the debugging port on the default
profile. Check it is up with `curl http://localhost:9222/json/version`. `PW_CDP_URL=http://host:9222`
reaches a browser elsewhere.

Headless works the same way (`chrome --headless=new --remote-debugging-port=9222
--user-data-dir=/tmp/chrome-headless`). Nobody answers a headless browser's dialogs: `dialog
accept|dismiss` does. Pages start at about 800x600; `viewport 1280x800` changes it.

**Browser on the host, REPL in a container:** with host networking, `localhost:9222` reaches the host's
browser directly. Otherwise set `PW_CDP_URL` to the host's address as seen from the container (for example
the Docker bridge gateway, `ip route | awk '/default/ {print $3}'`).

## Ways to run it

| Command                      | What you get                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `pw-repl run`                | a prompt in this terminal; `send` reaches it only through a tmux session named `playwright-repl` |
| `pw-repl serve`              | a prompt (`pw[serve]>`), plus a command server on `/tmp/playwright-repl.sock`; `send` needs no tmux |
| `pw-repl serve --background` | no terminal: `attach` to use it, `stop` to stop it, `where` to find it; output in `/tmp/playwright-repl.log` |

- For `send` to reach `run`, start it in tmux: `tmux new -s playwright-repl`, then `pw-repl run` there.
- A URL after the command opens in a new tab: `pw-repl run http://localhost:3000`.
- `--launch` works with each of them; flags after `--` go to that Chromium.
- A socket of its own: `-e /tmp/mine.sock` on every command, `serve` included (`pw-repl serve --background
  -e /tmp/mine.sock`), or `PW_SOCKET`; `serve <port>` listens on TCP on 127.0.0.1.
- A background REPL cannot be brought back like a Ctrl-Z job; `attach` is how you get back to it, from
  any terminal.

## Common tasks

| I want to…                           | Commands                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| see where I am                       | `tab`, `info`                                                                         |
| see what is on the page              | `snapshot`, `screenshot`                                                              |
| do something on it                   | `click`, `fill`, `press`                                                              |
| wait for a page or element           | `wait load`, `wait <selector>`, `wait <selector> --gone`                              |
| choose a file in a file input        | `upload <selector> <file>`                                                            |
| see it as a phone, or in dark mode   | `emulate mobile`, `emulate dark` (also `emulate locale`, `emulate timezone`)          |
| see what the page requested          | `requests`, then `body <#>` for what one got back                                     |
| see console messages and errors      | `console`                                                                             |
| show an agent what I do              | `watch on`, click around in the browser, then `watch`                                 |
| see each step as I click             | `watch on --live`                                                                     |
| record requests and console together | `capture on`, then `capture off`                                                      |
| record a video of the page           | `record on`, then `record off` (`help video` for a take with a pointer)               |
| show a pointer where the agent acts  | `cursor on`, then `cursor off` (in screenshots and videos)                            |
| point something out on the page      | `highlight <ref>`: a box, unlabelled unless `--labels on`; `highlight off` hides it   |
| break the backend on purpose         | `route <glob> <status> <json>` (fake a response), `route <glob> abort`, `network off` |
| change or slow an API response       | `route <glob> patch <json>`, `route <glob> delay <secs>`                              |
| slow the whole network               | `network slow`                                                                        |
| clean up                             | `modes off`                                                                           |

Everything else is in `help <topic>`; `help <command>` has usage and caveats.

### Modes

`watch`, `capture`, `route`, `network off` or `slow`, `emulate`, `viewport`, `record`, `highlight` and `cursor`
stay on until you turn them off: `watch on|off`, `capture on|off`, `route ...|route off`, `network off|slow|on`,
`emulate ...|emulate off`, `viewport <WxH>|viewport off`, `record on|off`, `highlight <selector>|highlight off`
(and `highlight --labels on|off`), `cursor on|off`.
While any are on in the selected tab, the prompt shows them: `(watch network:off routes:2) pw>`. `modes`
lists them for every tab, and `modes off` turns them all off.

`tab`, `watch`, `capture`, `route`, `network`, `emulate`, `viewport`, `record`, `highlight`, `cursor` and `modes` on
their own show their state and what you can run next.

## How it differs from playwright-cli

[playwright-cli](https://github.com/microsoft/playwright-cli) is Microsoft's command line for agents. It
gives each agent a browser session of its own; pw-repl shares one browser between a person and agents.
Its command names and most of their options work here too (`help playwright-cli` lists them), and where
pw-repl differs, it is mostly because someone else may be using the browser:

- `open` and `close` open a tab and turn off your modes; they never start, close or wipe a browser.
- Routes, network and emulation apply to one tab, not the whole browser.
- File pickers are not caught, since they may be the person's: `upload` names the input instead.
- There is no snapshot after every command, since a person reads the REPL too; `snapshot` shows one.
- Instead of `-s=<session>`, an agent is a client of its own (`send -c <name>`).
- `watch` records what a person does as steps with their requests, not as generated code.
- `highlight` draws its box without Playwright's locator label, which covers what is below it and puts
  selectors in screenshots and videos; `highlight --labels on` shows it.

For a browser of its own per agent, isolated sessions, traces, video, PDFs or generated test code,
playwright-cli is the better fit. `record on` records a tab's page, and `cursor on` draws a pointer where the
agent acts; for the shared browser as you see it, use a screen recorder (`ffmpeg -f x11grab`, macOS
`screencapture -v`, OBS).

## From scripts and agents

### A skill for agents

`pw-repl skill` prints an agent skill (`SKILL.md`) that teaches an agent to use the REPL: how to start
it, send commands, and share the browser with a person. Save it as `pw-repl/SKILL.md` in the folder
your agent reads skills from:

```bash
mkdir -p <skills folder>/pw-repl
npx pw-repl@latest skill > <skills folder>/pw-repl/SKILL.md
```

It is stamped with the version it came from and a hash of its text, and `pw-repl where` names the skill
of the pw-repl being run, so an agent can tell when its saved copy is out of date and offer to update it
(keeping its Custom rules section). Working on the REPL itself: see `AGENTS.md`.

### send, clients and where

```bash
pw-repl send info
pw-repl send help       # the REPL's commands; works without a running REPL
pw-repl where           # which REPL send would reach
```

`pw-repl send` sends one command and prints its result, through the server when it is running and through the
`playwright-repl` tmux session otherwise. Chain several in the shell: `&&` stops at the first that fails or
is not confirmed (exit 1 or 2), `;` runs on.

Several agents can share one REPL: `pw-repl send -c <name>` (or `PW_CLIENT=<name>`) sends as a client with a
selected tab of its own, shown in the pane as `[server:<name>]`. `modes` says which client turned each mode on,
and `modes off --mine` turns off only the sender's own.

### The HTTP protocol

With `pw-repl serve`, the server speaks HTTP with JSON, for clients of your own:

```bash
curl --unix-socket /tmp/playwright-repl.sock -H 'Content-Type: application/json' \
  -d '{"command": "info"}' http://localhost/run
```

It returns `{"status": "ok" | "error", "output": "..."}`, plus `"unconfirmed": true` when the command may or
may not have done what it was sent to do (it timed out, or the REPL quit while it ran and it was not
read-only). While the REPL starts, `/run` answers 503 with `"starting": true`: retry. `GET /health` says
`"status": "starting"` until it serves, then `"ok"`. `pw-repl serve <port>` serves TCP on 127.0.0.1
instead; other addresses are refused.

## Tests

```bash
npm test
```

Needs Node.js 21 or newer. Runs against a private headless Chromium it starts itself (`PW_TEST_CHROME`, or
the one `--launch` would use: Playwright's, e.g. from `npx playwright-core install chromium`, then one on
the `PATH`) and a local test site; the browser tests are skipped when no Chromium is found.
