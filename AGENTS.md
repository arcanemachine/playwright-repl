# Agent Instructions — playwright-repl

How to use the REPL is in the skill `bin/pw-repl.js skill` prints (from `skill/SKILL.md`, stamped with
its version and hash). Read it first. In this clone, `pw-repl` there means `bin/pw-repl.js` (from the
folder this file is in) when it is not installed globally.

## Contributing

If you hit a limitation or write a workaround, consider adding the capability to the REPL instead.

- A command is a function in the `commands` object of the module for what it works on, plus an entry
  in `lib/help.js` under one topic; `lib/commands.js` gathers every module's commands. A command that
  needs no tab, only reads, or takes `--all` is also listed in `lib/runner.js`'s `NO_TAB_NEEDED`,
  `READ_ONLY` or `INSPECTION`, and one that takes fixed words in `complete` (`lib/commands.js`).
- The modules, one per facility, each with its commands: `lib/tabs.js` (tabs, navigating),
  `lib/elements.js` (choosing a match; the interact and mouse commands; highlight), `lib/cursor.js` (the pointer
  drawn over the page, which the element and mouse commands glide first), `lib/inspect.js` (reading the
  page, screenshots, eval, CDP, waits), `lib/watch.js`, `lib/requestlog.js` (requests, bodies, console),
  `lib/routes.js`, `lib/network.js`, `lib/emulation.js` (and viewport), `lib/capture.js`, `lib/record.js`
  (video, through ffmpeg, and the steps file saved with it), `lib/dialogs.js` and `lib/modes.js`. Beneath them, `lib/tabstate.js` is the one record kept per tab, `lib/cdp.js` the CDP
  session kept per tab, and `lib/util.js` small shared helpers. No facility requires `lib/modes.js` or
  `lib/commands.js`, and a unit test fails on a require cycle, which CommonJS would not report.
- `bin/pw-repl.js` is the command line; `lib/start.js` connects and runs the prompt; `lib/runner.js`
  runs commands one at a time (`quit` and `dialog` skip its queue); `lib/server.js` is the command
  server; `lib/send.js` and `lib/client.js` are `send` and `where`; `lib/background.js` is
  `serve --background`, `attach` and `stop`; `lib/launch.js` is `--launch`; `lib/syntax.js` is how a
  command line's words are read, shared with `send`; `lib/cli-names.js` maps playwright-cli's command
  names to these; `lib/state.js` holds the session state, with each client's selected tab;
  `lib/output.js` routes all output so the server can return it; `lib/skill.js` stamps the skill
  `pw-repl skill` prints, and gives `where` its hash.
- Match Playwright and playwright-cli (Microsoft's CLI for agents) as closely as is reasonable: agents are
  likelier to be trained on them. A new command, option or output that does what one of theirs does takes
  its name, form and API style (an option named as Playwright's API names it, e.g. type's `delay`), or
  accepts theirs too (`lib/cli-names.js`, `help playwright-cli`). Deviate only where it is necessary, as
  where sharing a browser with a user needs it, and say why in the help.
- Comment the *why* when it isn't obvious from the code.
- `npm test` runs the suite (under two minutes): a private headless Chromium, a local test site
  (`test/harness.js`), and the real REPL with its server. Nothing is mocked, and the shared browser is
  never touched. It finds Chromium through `PW_TEST_CHROME`, or where `--launch` looks (Playwright's
  browsers, then the `PATH`), and skips the browser tests if there is none. Add a test with each new
  command or behaviour. In `test/repl.test.js` each test starts in a fresh tab of its own, and every mode
  is turned off after it; a test whose REPL quits, times out or is killed goes in
  `test/repl-alone.test.js`, with a Chromium of its own.
- Help entries (`lib/help.js`) are plain paragraphs: `wrap()` lays each out at 104 columns, and keeps as
  written a paragraph with a bullet, a table or an indented example. `test/fixtures` holds the rendered
  help; after an intended change to it, save it again (the command is in `test/units.test.js`).
- Time each full run, and put the result in the body of the commit it tests (`npm test: 151 tests, 79s`).
  Compare with the last commit that has one (`git log --grep='npm test:'`): a run that grew by more than
  a few seconds means a slow test crept in, usually one waiting out a real timeout (5s for a click).
  Find it (each test prints its time) and make it faster, or say why it can't be, before committing.
- Don't race the clock in a test: a page that changes on a timer, or a command timed against a budget,
  fails on a busy machine. Have the page change when the test asks (eval), or measure the thing itself
  (frames drawn, not clicks timed). A click waits for its element to hold still for two frames.
- For anything the tests can't reach, exercise the change in a running REPL of your own: on a socket of
  your own, with `--launch` unless the change needs the user's browser, and then in a tab of your own.
- `skill/SKILL.md` is how agents learn to use the REPL: keep it in step with a change to how it is
  used, and leave its Custom rules section empty. Keep its `<!-- pw-repl skill stamp -->` line: `pw-repl
  skill` replaces it with the version and a hash of the skill's text, which `where` reports, so agents
  can tell a saved copy is out of date.

## Waves

Work goes in waves, and each one ends with a release that is ready to push.

1. Build what was asked, with tests, and try it in a running REPL. For anything the user will look at
   (a cursor, an overlay, a video), show them a demo while it is still a prototype (a recording or
   screenshots they can open) and get their go-ahead on how it looks before writing tests or
   building on it.
2. Try it on a fresh agent that has not seen the code or the change (a guinea pig), on something real: a
   small local page whose planted bugs need the change to find.
   - Brief it with goals only: what to find out or do in the browser, never the commands.
   - First it reads back its plan, learned from `pw-repl skill` and help alone: the commands, where it
     found them, and what is unclear. It runs nothing yet.
   - A wrong or unsure plan means the docs or the brief were unclear: find out which, fix that, then
     ask again.
   - Then it carries the plan out, in a browser and on a socket of its own, and reports as it goes:
     above all, where the tool did something other than what the docs led it to expect.
   - Once it has confirmed the fixes work, it reviews them as a second pair of eyes: anything important
     they miss or get wrong, not nitpicks.
3. Triage what it reports. Fix what matters, and what is small and useful; don't put off something
   useful for later. Leave trivia alone, and say why.
4. Repeat 2 and 3, with a fresh agent each time, until a pass comes back clean: no real bugs, and
   nothing unclear in the docs or the brief that changed the plan. A pass after fixes tries the fixes,
   and something not tried yet.
5. Only then cut the release (Releasing, steps 1-3), and say it is ready. The maintainer pushes and
   publishes it, and the next wave starts from what they find. A release cut too early and not pushed
   yet is undone (its commit and tag) and cut again after the fixes.

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
