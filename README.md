# playwright-repl

A text REPL for driving an existing Chromium through Playwright over CDP. You and agents can share the same
browser: people click in it, and the REPL inspects it, fakes responses, and records what happened.

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

### 2. Install and start the REPL

```bash
npm install -g pw-repl
pw-repl                  # connects to localhost:9222 (same as pw-repl run)
```

Without installing: `npx pw-repl` (subcommands work the same way).
From a clone: `npm install`, then `bin/pw-repl.js run` (or `npm link` to get `pw-repl`).

It lists the open tabs and shows a `pw>` prompt. To send it commands from scripts or agents later
(`pw-repl send`), run it in a tmux session named `playwright-repl` (`tmux new -s playwright-repl`), or
start it with `pw-repl serve` instead, which needs no tmux.

### 3. Try it

```text
pw> help                          # common tasks and topics; help <topic>, help <command>, help --all
pw> tab new https://example.com   # open your own tab to work in
pw> snapshot                      # the page by role and name, with [ref=eN] labels
pw> click aria-ref=e3             # click by label (or any Playwright selector)
pw> requests                      # requests the tab made
pw> tab close
```

Commands act on the selected tab (`tab` lists the tabs, with `*` on the selected one).

## Common tasks

| I want to…                           | Commands                                                        |
| ------------------------------------ | --------------------------------------------------------------- |
| see where I am                       | `tab`, `info`                                                   |
| see what is on the page              | `snapshot`, `screenshot`                                        |
| do something on it                   | `click`, `fill`, `press`                                        |
| see what the page requested          | `requests`, then `body <#>` for what one got back               |
| see console messages and errors      | `console`                                                       |
| show an agent what I do              | `watch on`, click around in the browser, then `watch`           |
| see each step as I click             | `watch on --live`                                               |
| record requests and console together | `capture on`, then `capture off`                                |
| break the backend on purpose         | `route <glob> <status> <json>` (fake a response), `network off` |
| clean up                             | `modes off`                                                     |

Everything else is in `help <topic>`; `help <command>` has usage and caveats.

### Modes

`watch`, `capture`, `route` and `network off` stay on until you turn them off: `watch on|off`,
`capture on|off`, `route ...|route off`, `network off|on`. While any are on in the selected tab, the prompt
shows them: `(watch network:off routes:2) pw>`. `modes` lists them for every tab, and `modes off` turns them
all off.

`tab`, `watch`, `capture`, `route`, `network` and `modes` on their own show their state and what you can
run next.

## Options

```bash
pw-repl http://localhost:3000            # connect and navigate tab [0] to a URL
pw-repl serve                            # also accept commands on /tmp/playwright-repl.sock (prompt: pw[serve]>)
PW_CDP_URL=http://host:9222 pw-repl run  # a browser elsewhere
```

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

### A skill for agents

`pw-repl skill` prints an agent skill (`SKILL.md`) that teaches an agent to use the REPL: how to start
it, send commands, and share the browser with a person. Save it as `playwright-repl/SKILL.md` in the
folder your agent reads skills from:

```bash
mkdir -p <skills folder>/playwright-repl
pw-repl skill > <skills folder>/playwright-repl/SKILL.md
```

The same text is in `skill/SKILL.md`. Working on the REPL itself: see `AGENTS.md`.

## Tests

```bash
npm test
```

Runs against a private headless Chromium it starts itself (via `PW_TEST_CHROME`, or Playwright's installed
browsers: `npx playwright-core install chromium`) and a local test site; the browser tests are skipped when no
Chromium is found.
