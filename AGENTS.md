# Agent Instructions — playwright-repl

How to use the REPL is in `skill/SKILL.md` (the same text `pw-repl skill` prints). Read it first. In
this clone, `pw-repl` there means `bin/pw-repl.js` (from the folder this file is in) when it is not
installed globally.

## Contributing

If you hit a limitation or write a workaround, consider adding the capability to the REPL instead.

- A command is a function in the `commands` object in `lib/commands.js`, plus an entry in `lib/help.js`
  under one topic.
- `bin/pw-repl.js` is the command line; `lib/start.js` connects and runs the prompt; `lib/runner.js`
  runs commands one at a time (`quit` and `dialog` skip its queue); `lib/server.js` is the command
  server; `lib/send.js` and `lib/client.js` are `send` and `where`; `lib/background.js` is
  `serve --background`, `attach` and `stop`; `lib/launch.js` is `--launch`; `lib/syntax.js` is how a
  command line's words are read, shared with `send`; `lib/state.js` holds the session state;
  `lib/output.js` routes all output so the server can return it.
- Comment the *why* when it isn't obvious from the code.
- `npm test` runs the suite (about a minute): a private headless Chromium, a local test site
  (`test/harness.js`), and the real REPL with its server. Nothing is mocked, and the shared browser is
  never touched. It finds Chromium through `PW_TEST_CHROME`, or where `--launch` looks (Playwright's
  browsers, then the `PATH`), and skips the browser tests if there is none. Add a test with each new
  command or behaviour.
- For anything the tests can't reach, exercise the change in a running REPL. Use your own tmux session
  and a new tab, not the user's.
- `skill/SKILL.md` is how agents learn to use the REPL: keep it in step with a change to how it is
  used, and leave its Custom rules section empty.

## Waves

Work goes in waves, and each one ends with a release that is ready to push.

1. Build what was asked, with tests, and try it in a running REPL.
2. Try it on a fresh agent that has not seen the code or the change (a guinea pig), on something real: a
   small local page whose planted bugs need the change to find.
   - Brief it with goals only: what to find out or do in the browser, never the commands.
   - First it reads back its plan, learned from `pw-repl skill` and help alone: the commands, where it
     found them, and what is unclear. It runs nothing yet.
   - A wrong or unsure plan means the docs are wrong: fix them, then ask again.
   - Then it carries the plan out, in a browser and on a socket of its own, and reports as it goes:
     above all, where the tool did something other than what the docs led it to expect.
3. Triage what it reports. Fix what matters, and what is small and useful; don't put off something
   useful for later. Leave trivia alone, and say why.
4. Repeat 2 and 3 while the fixes are substantial.
5. Cut the release (Releasing, steps 1-3) and say it is ready. The maintainer pushes and publishes it,
   and the next wave starts from what they find.

## Releasing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
`test:`, `chore:` and so on, with an optional scope (`fix(watch): ...`). Versions follow semver; before
1.0, a change that breaks how the REPL is used is a minor bump (0.2.0 to 0.3.0), anything else a patch.

1. `npm test` passes and the working tree is clean.
2. `npm outdated` and `npm audit` show nothing that needs doing first.
3. `npm version <patch|minor|major> -m "chore: release %s"` sets the version in `package.json` and
   `package-lock.json`, commits it as `chore: release X.Y.Z`, and tags that commit `vX.Y.Z`.
4. `git push --follow-tags` pushes the commits and the tag.
5. `npm publish` publishes it; `prepublishOnly` runs the tests again first.

Pushing and publishing need the maintainer's GitHub and npm credentials.
