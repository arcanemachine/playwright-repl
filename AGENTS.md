# Agent Instructions — playwright-repl

How to use the REPL is in `skill/SKILL.md` (the same text `pw-repl skill` prints). Read it first. In
this clone, `pw-repl` there means `bin/pw-repl.js` (from the folder this file is in) when it is not
installed globally.

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
- `skill/SKILL.md` is how agents learn to use the REPL: keep it in step with a change to how it is
  used, and leave its Custom rules section empty.
