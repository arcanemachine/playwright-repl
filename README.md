# playwright-repl

A text REPL for driving an existing Chromium through Playwright over CDP: one session that people and agents
share. People click in the browser and type commands at the prompt; agents send the same commands, and every
one shows in the REPL, so each sees what the other does. The REPL inspects the page, records what happened
(requests, console, and each step a person takes), fakes, patches or slows responses, and emulates phones,
dark mode, locales and timezones.

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

## How it differs from playwright-cli

[playwright-cli](https://github.com/microsoft/playwright-cli) is Microsoft's command line for agents. It
gives each agent a browser session of its own; pw-repl shares one browser between a person and agents.
Its command names and most of their options work here too (`help playwright-cli` lists them), and where
pw-repl differs, it is because someone else may be using the browser:

- `open` and `close` open a tab and turn off your modes; they never start, close or wipe a browser.
- Routes, network and emulation apply to one tab, not the whole browser.
- File pickers are not caught, since they may be the person's: `upload` names the input instead.
- There is no snapshot after every command, since a person reads the REPL too; `snapshot` shows one.
- Instead of `-s=<session>`, an agent is a client of its own (`send -c <name>`).
- `watch` records what a person does as steps with their requests, not as generated code.

For a browser of its own per agent, isolated sessions, traces, video, PDFs or generated test code,
playwright-cli is the better fit.

## Getting started

### Prerequisites

- Node.js 20 or newer (`npm test` needs 21 or newer).
- A Chromium-based browser (Chrome, Chromium, ungoogled-chromium, ...).
- Optional: tmux, to use `pw-repl send` without the command server.

### 1. Start the browser with remote debugging

```bash
chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/chrome-debug"
# or: chromium --remote-debugging-port=9222 --user-data-dir="$HOME/.config/chromium-debug"
```

Use a separate `--user-data-dir`: recent Chrome versions do not open the debugging port on the default
profile. Check it is up with `curl http://localhost:9222/json/version`.

**No browser to hand, or one you would rather not share?** Skip this step: `pw-repl run --launch` (or
`serve --launch`) starts a private headless Chromium for the REPL and stops it with the REPL. It prints the
command it ran, so you can start one your own way instead. If there is no Chromium at all,
`npx playwright-core install chromium` downloads Playwright's.

**Headless** works the same way:

```bash
chrome --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-headless
```

With nobody at the browser, `dialog accept` or `dialog dismiss` answers a dialog (`alert`, `confirm`);
the REPL never answers one on its own. Pages start at about 800x600; `viewport 1280x800` sets another
size.

### 2. Install and start the REPL

```bash
npm install -g pw-repl
pw-repl run              # connects to localhost:9222; pw-repl on its own shows the usage
```

Without installing: `npx pw-repl` (subcommands work the same way).
From a clone: `npm install`, then `bin/pw-repl.js run` (or `npm link` to get `pw-repl`).

It lists the open tabs and shows a `pw>` prompt. To send it commands from scripts or agents later
(`pw-repl send`), run it in a tmux session named `playwright-repl` (`tmux new -s playwright-repl`), or
start it with `pw-repl serve` instead, which needs no tmux (`pw-repl serve --background` runs it without
a terminal; see [In the background](#in-the-background)).

### 3. Try it

```text
pw> help                          # common tasks and topics; help <topic>, help <command>, help --all
pw> tab new https://example.com   # open your own tab to work in
pw> snapshot                      # the page by role and name, with [ref=eN] labels
pw> click e3                      # click by snapshot ref (or any Playwright selector)
pw> requests                      # requests the tab made
pw> tab close
```

Commands act on the selected tab (`tab` lists the tabs, with `*` on the selected one).

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
| break the backend on purpose         | `route <glob> <status> <json>` (fake a response), `route <glob> abort`, `network off` |
| change or slow an API response       | `route <glob> patch <json>`, `route <glob> delay <secs>`                              |
| slow the whole network               | `network slow`                                                                        |
| clean up                             | `modes off`                                                                           |

Everything else is in `help <topic>`; `help <command>` has usage and caveats.

### Modes

`watch`, `capture`, `route`, `network off` or `slow`, and `emulate` stay on until you turn them off:
`watch on|off`, `capture on|off`, `route ...|route off`, `network off|slow|on`, `emulate ...|emulate off`.
While any are on in the selected tab, the prompt shows them: `(watch network:off routes:2) pw>`. `modes`
lists them for every tab, and `modes off` turns them all off.

`tab`, `watch`, `capture`, `route`, `network`, `emulate` and `modes` on their own show their state and what
you can run next.

## Options

```bash
pw-repl run http://localhost:3000        # connect and open a URL in a new tab
pw-repl serve                            # also accept commands on /tmp/playwright-repl.sock (prompt: pw[serve]>)
PW_CDP_URL=http://host:9222 pw-repl run  # a browser elsewhere
```

### In the background

```bash
pw-repl serve --background   # detached, serving /tmp/playwright-repl.sock; output in /tmp/playwright-repl.log
pw-repl attach               # see everything it does and type commands to it; Ctrl-C leaves it running
pw-repl stop                 # stop it
pw-repl where                # is one running, and where
```

A background process cannot be brought back to the foreground like a Ctrl-Z job; `attach` is how you
get back to it, from any terminal.

**Browser on the host, REPL in a container:** with host networking, `localhost:9222` reaches the host's
browser directly. Otherwise set `PW_CDP_URL` to the host's address as seen from the container (for example
the Docker bridge gateway, `ip route | awk '/default/ {print $3}'`).

## From scripts and agents

```bash
pw-repl send info
pw-repl send help       # the REPL's commands; works without a running REPL
pw-repl where           # which REPL send would reach
```

`pw-repl send` sends one command and prints its result, through the server when it is running and through the
`playwright-repl` tmux session otherwise. The server speaks HTTP with JSON:

```bash
curl --unix-socket /tmp/playwright-repl.sock -H 'Content-Type: application/json' \
  -d '{"command": "info"}' http://localhost/run
```

It returns `{"status": "ok" | "error", "output": "..."}`, plus `"unconfirmed": true` when the command may or
may not have done what it was sent to do (it timed out, or the REPL quit while it ran and it was not
read-only). It is off unless started with `pw-repl serve`.
`pw-repl serve <port>` serves TCP on 127.0.0.1 instead; other addresses are refused.

Several agents can share one REPL: `pw-repl send -c <name>` (or `PW_CLIENT=<name>`) sends as a client with a
selected tab of its own, shown in the pane as `[server:<name>]`. `modes` says which client turned each mode on,
and `modes off --mine` turns off only the sender's own.

### A skill for agents

`pw-repl skill` prints an agent skill (`SKILL.md`) that teaches an agent to use the REPL: how to start
it, send commands, and share the browser with a person. Save it as `pw-repl/SKILL.md` in the folder
your agent reads skills from:

```bash
mkdir -p <skills folder>/pw-repl
pw-repl skill > <skills folder>/pw-repl/SKILL.md
```

The same text is in `skill/SKILL.md`. Working on the REPL itself: see `AGENTS.md`.

## Tests

```bash
npm test
```

Runs against a private headless Chromium it starts itself (`PW_TEST_CHROME`, or the one `--launch` would
use: Playwright's, e.g. from `npx playwright-core install chromium`, then one on the `PATH`) and a local
test site; the browser tests are skipped when no Chromium is found.
