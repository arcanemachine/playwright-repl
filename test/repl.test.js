const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { SKIP, waitFor, startChrome, startSite, startRepl } = require('./harness');

describe('REPL against a real browser', { skip: SKIP }, () => {
  let chrome, site, repl;

  before(async () => {
    chrome = await startChrome();
    site = await startSite();
    repl = await startRepl(chrome.cdpUrl);
  });

  // Each test starts in a fresh fixture tab, so none depends on what an earlier one left behind.
  beforeEach(async () => {
    const opened = await repl.run(`tab new ${site.url}/`);
    assert.equal(opened.status, 'ok', opened.output);
  });

  // Every mode off, and every tab but the first closed, through the REPL so it sees each one go.
  // A dialog a failed test left open would hold every command after it, so it is dismissed first.
  afterEach(async () => {
    while (/^\[\d+\]/.test((await repl.run('dialog')).output)) await repl.run('dialog dismiss');
    const off = await repl.run('modes off');
    assert.equal(off.status, 'ok', off.output);
    for (;;) {
      const tabs = (await repl.run('tab')).output.match(/^[* ] \[\d+\]/gm) || [];
      if (tabs.length <= 1) break;
      await repl.run('tab 1');
      const closed = await repl.run('tab close');
      assert.equal(closed.status, 'ok', closed.output);
    }
  });

  after(async () => {
    await repl?.stop();
    site?.stop();
    await chrome?.stop();
  });

  const ok = async command => {
    const result = await repl.run(command);
    assert.equal(result.status, 'ok', `${command}\n${result.output}`);
    return result.output;
  };
  const fetchStatus = 'eval fetch("/api/data").then(r => r.status, e => String(e))';

  it('clicks the first match that can be clicked, and says which, or why none can', async () => {
    await ok(`tab new ${site.url}/pick`);
    try {
      const log = 'eval log.textContent';
      assert.equal(await ok('click text=Pick'), 'Clicked: text=Pick (match 3 of 3; the ones before it are hidden or covered)');
      assert.equal(await ok(log), 'free ');
      assert.match(await ok('hover text=Pick'), /^Hovered: text=Pick \(match 3 of 3;/);
      assert.equal(await ok('click #free'), 'Clicked: #free', 'a single match as before');
      const none = await repl.run('dblclick text=Covered');
      assert.equal(none.status, 'error');
      assert.equal(none.unconfirmed, undefined, 'nothing was done');
      assert.match(none.output, /^Error: None of the 2 matches for text=Covered could be acted on after 5s, so nothing was done:\n  <button> Covered: covered by <div>\n  <button> Covered: covered by <div>\n/);
      assert.equal(await ok(log), 'free free ');
      assert.equal(await ok('click text=Far'), 'Clicked: text=Far', 'the first in page order, out of view or not');
      assert.equal(await ok(log), 'free free far-first ');
      await ok('eval scrollTo(0, 0)');
      for (let i = 0; i < 5; i += 1) assert.match(await ok('click text=Again'), /^Clicked: text=Again \(match 2 of 2;/, 'chosen again when rendered again');
      assert.equal(await ok(log), 'free free far-first redrawn redrawn redrawn redrawn redrawn ');
    } finally {
      await ok('tab close');
    }
  });

  it('moves the mouse, presses its buttons and turns its wheel at a point', async () => {
    await ok(`tab new ${site.url}/pick`);
    try {
      assert.equal(await ok('mousemove 50 350'), 'Moved the mouse to 50, 350');
      assert.equal(await ok('mousedown'), 'Pressed the left button');
      assert.equal(await ok('mouseup'), 'Released the left button');
      assert.equal(await ok('mousewheel 0 -120'), 'Turned the wheel by 0, -120');
      await ok('mousedown right');
      await ok('mouseup right');
      assert.equal(await ok('eval log.textContent.trim()'), 'mousedown:0@50,350 mouseup:0@50,350 click:0@50,350 wheel:-120@50,350 mousedown:2@50,350 mouseup:2@50,350');
      assert.match((await repl.run('mousemove 50')).output, /Usage: mousemove <x> <y>/);
      assert.match((await repl.run('mousedown sideways')).output, /Usage: mousedown \[left\|right\|middle\]/);
      assert.match((await repl.run('mousewheel a b')).output, /Usage: mousewheel <dx> <dy>/);
    } finally {
      await ok('tab close');
    }
  });

  it('reads and drives the page', async () => {
    assert.match(await ok('info'), /Title: Fixture$/m);
    await ok('fill #name Ada');
    await ok('click #go');
    assert.equal(await ok('text #out'), 'Hello Ada');
    assert.match(await ok('links'), /"href": "http:\/\/127\.0\.0\.1:\d+\/other"/);
  });

  it('takes the selector as the first word, quoted if it has spaces, and the value as the rest', async () => {
    const value = 'eval document.querySelector("#name").value';
    await ok('fill #name Ada Lovelace');
    assert.equal(await ok(value), 'Ada Lovelace');
    await ok('fill "label:has-text(\'Name\') input" "Grace Hopper"');
    assert.equal(await ok(value), 'Grace Hopper');
    await ok('fill #name ""');
    assert.equal(await ok(value), '""');
    const missing = await repl.run('fill #name');
    assert.equal(missing.status, 'error');
    assert.match(missing.output, /Usage: fill <selector> <value> \[--submit\], e\.g\. fill #name Ada Lovelace/);
    await ok('press #name Enter');
    const { spawnSync } = require('child_process');
    const path = require('path');
    const sent = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'pw-repl.js'), 'send', '-e', repl.socket, 'fill', "label:has-text('Name') input", 'Katherine Johnson'], { encoding: 'utf8' });
    assert.equal(sent.status, 0, sent.stderr);
    assert.equal(await ok(value), 'Katherine Johnson', 'send keeps a word with spaces whole');
    const evaluated = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'pw-repl.js'), 'send', '-e', repl.socket, 'eval', 'document.querySelector("#name").value + " " + \'x y\'.length'], { encoding: 'utf8' });
    assert.equal(evaluated.stdout.trim(), 'Katherine Johnson 3', 'eval gets its words as they are');
        const typed = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'pw-repl.js'), 'send', '-e', repl.socket, 'type', '#name', ' Jr'], { encoding: 'utf8' });
    assert.equal(typed.status, 0, typed.stderr);
    assert.equal(await ok(value), 'Katherine Johnson Jr', 'type adds to the end, leading space and all');
    const cleared = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'pw-repl.js'), 'send', '-e', repl.socket, 'fill', '#name', ''], { encoding: 'utf8' });
    assert.equal(cleared.status, 0, cleared.stdout + cleared.stderr);
    assert.equal(await ok(value), '""', 'an empty word through send clears the field');
  });

  it('takes key names in any case, as playwright-cli does', async () => {
    await ok('fill #name ab');
    await ok('press #name arrowleft');
    await ok('press #name shift+arrowleft');
    assert.equal(await ok('eval [document.querySelector("#name").selectionStart, document.querySelector("#name").selectionEnd].join()'), '0,1');
    await ok('fill #name ""');
  });

  it('clicks with a button and modifiers', async () => {
    await ok('eval window.clicks = []; for (const t of ["click", "contextmenu", "auxclick", "dblclick"]) document.querySelector("#go").addEventListener(t, e => clicks.push(`${t}:${e.button}:${e.shiftKey}`)); 0');
    const ref = /button "Go" \[ref=((?:f\d+)?e\d+)\]/.exec(await ok('snapshot'))[1];
    assert.equal(await ok(`click ${ref} right`), `Clicked: ${ref} right`);
    await ok(`click "#go" middle`);
    await ok(`click ${ref} --modifiers="shift"`);
    await ok(`dblclick ${ref}`);
    assert.equal(await ok('eval clicks.join(" ")'), 'contextmenu:2:false auxclick:2:false auxclick:1:false click:0:true click:0:false click:0:false dblclick:0:false');
    assert.match((await repl.run(`click ${ref} --modifiers=Hyper`)).output, /Not a modifier: Hyper/);
    await ok('eval document.querySelector("#out").insertAdjacentHTML("afterend", \'<button id="hold" onclick="window.held = event.shiftKey">Hold --modifiers Shift</button>\'); 0');
    await ok('click "text=Hold --modifiers Shift"');
    assert.equal(await ok('eval window.held'), 'false', 'kept whole in quotes: its text, no Shift');
    await ok('eval document.querySelector("#hold").remove(); 0');
  });

  it('clicks without delay in a tab that stays in the background', async () => {
    await ok(`tab new ${site.url}/?background-clicks`);
    const started = Date.now();
    for (let i = 0; i < 5; i++) await ok('click #go');
    // Chrome all but stops drawing a background tab after input: 1-2s a click, without the screencast.
    assert.ok(Date.now() - started < 2500, `5 clicks took ${Date.now() - started}ms`);
    await ok('tab close');
  });

  it('calls a function on an element with eval <function> <ref>', async () => {
    const ref = /button "Go"[^\n]*\[ref=((?:f\d+)?e\d+)\]/.exec(await ok('snapshot --grep Go'))[1];
    assert.equal(await ok(`eval "el => el.textContent" ${ref}`), 'Go');
    assert.equal(await ok(`eval (el => el.textContent) ${ref}`), 'Go', 'wrapped in parentheses');
    assert.match((await repl.run(`eval (el => el)(document.body).id ${ref}`)).output, /SyntaxError/, 'a call, not a function');
    assert.equal(await ok(`eval (el) => el.id ${ref}`), 'go');
    assert.equal(await ok('eval 1 + 1'), '2', 'an expression is evaluated as before');
    assert.equal(await ok('eval ""'), '""', 'an empty string is shown as one');
    assert.equal(await ok('eval (await fetch("/api/data")).status'), '200', 'await at the top level');
    assert.equal(await ok('eval const r = await fetch("/api/data"); await r.json()'), '{\n  "real": true\n}', 'statements with await give the last one\'s value');
    assert.match((await repl.run('eval await Promise.reject(new Error("nope")); 1')).output, /Error: nope/);
    try {
      await ok(`tab new ${site.url}/frame`);
      const inner = /button "inner" \[ref=(f\d+e\d+)\]/.exec(await ok('snapshot'))[1];
      assert.equal(await ok(`eval el => el.textContent ${inner}`), 'inner', 'an element in an iframe');
    } finally {
      await ok('tab close frame');
    }
  });

  it('submits with --submit, and types into the focused element', async () => {
    const value = 'eval document.querySelector("#name").value';
    await ok('eval window.entered = 0; document.querySelector("#name").addEventListener("keydown", e => { if (e.key === "Enter") window.entered += 1; }); 0');
    assert.equal(await ok('fill #name "a  b" --submit'), 'Filled and submitted: #name');
    assert.equal(await ok(value), 'a  b', 'the value without --submit or its quotes');
    assert.equal(await ok('eval window.entered'), '1');
    await ok('click #name');
    assert.equal(await ok('type " c" --submit'), 'Typed into the focused input#name, and submitted');
    assert.equal(await ok(value), 'a  b c');
    assert.equal(await ok('eval window.entered'), '2');
    assert.match((await repl.run('fill #name hi --submit more')).output, /--submit goes at the end of the line/);
    await ok('eval document.querySelector("#go").focus(); 0');
    assert.match((await repl.run('type x')).output, /The focused element, button#go, takes no text: type <selector> <text>/);
    await ok('eval document.activeElement.blur(); 0');
    assert.match((await repl.run('type x')).output, /Nothing on the page has focus: type <selector> <text>/);
    await ok('fill #name ""');
  });

  it('selects a tab by a number in its URL when it is not a tab index', async () => {
    const port = new URL(site.url).port;
    await ok('tab');
    assert.match(await ok(`tab ${port}`), new RegExp(`URL: +\\S+:${port}/`));
    const none = await repl.run('tab 99999999');
    assert.equal(none.status, 'error');
    assert.match(none.output, /No tab \[99999999\] in the latest listing, and no tab URL contains 99999999/);
    // A client that has not listed tabs has no index to go by, and 1 is in every 127.0.0.1 URL.
    await ok(`tab new ${site.url}/other`);
    const unlisted = await repl.runAs('no-listing', 'tab 1');
    assert.equal(unlisted.status, 'error');
    assert.match(unlisted.output, /^Error: No tab \[1\] in a listing yet: each client has its own, from tab\. As part of a URL, 1 is in \d+ tabs\. Run tab, then tab <index>\.$/);
    // Another client lists the tabs, then the tab is closed behind its back.
    const listing = (await repl.runAs('lister', 'tab')).output;
    const index = new RegExp(`\\[(\\d+)\\] \\S+/other`).exec(listing)[1];
    await ok('tab close /other');
    const closed = await repl.runAs('lister', `tab ${index}`);
    assert.equal(closed.status, 'error', 'an index whose tab has closed is not read as part of a URL');
    assert.match(closed.output, new RegExp(`^Error: Tab \\[${index}\\] has closed since the latest listing\\. Run tab to list them again\\.$`));
  });

  it('lists the event listeners the page added to an element', async () => {
    await ok(`goto ${site.url}/`);
    await ok('eval document.querySelector("#load").addEventListener("click", function second() { return 2; }, { once: true }); "added"');
    const listed = await ok('listeners #load');
    assert.match(listed, /^click: function onclick\(event\) \{ ↵ fetch\('\/api\/data'\) ↵ \} \(line \d+\)$/m);
    assert.match(listed, /^click \(once\): function second\(\) \{ return 2; \} \(line \d+\)$/m);
    assert.match(await ok('listeners h1'), /No event listeners on h1/);
    // Playwright's own, which it adds to window as it clicks, are not the page's.
    await ok('eval window.addEventListener("keydown", function pageKeys() {}); 0');
    const snap = await ok('snapshot');
    await ok(`click ${/button "Go" \[ref=((?:f\d+)?e\d+)\]/.exec(snap)[1]}`);
    const onWindow = await ok('listeners window');
    assert.match(onWindow, /^keydown: function pageKeys\(\) \{\} \(line \d+\)$/m);
    assert.doesNotMatch(onWindow, /_hitTargetInterceptor|__playwright/);
    assert.match(onWindow, /^\(\d+ of Playwright's own left out\)$/m);
    await ok('eval document.querySelector("#load").addEventListener("keyup", function aLongHandlerName() { return "' + 'x'.repeat(120) + '"; }); 0');
    assert.match(await ok('listeners #load'), /^keyup: function aLongHandlerName\(\) \{ return "x+… \(line \d+\)$/m, 'the start only');
    assert.match(await ok('listeners --all #load'), /^keyup: function aLongHandlerName\(\) \{ return "x{120}"; \} \(line \d+\)$/m, 'all of it');
    // Made in the page, so the command stays one line and the handler has line breaks.
    await ok('eval document.querySelector("#load").addEventListener("keydown", eval("(function commented() {\\n  // a comment\\n  return 1;\\n})")); 0');
    assert.match(await ok('listeners #load'), /^keydown: function commented\(\) \{ ↵ \/\/ a comment ↵ return 1; ↵ \} \(line \d+\)$/m, 'line breaks marked');
    assert.match(await ok('listeners --all #load'), /^keydown: function commented\(\) \{\n      \/\/ a comment\n      return 1;\n    \} \(line \d+\)$/m, 'as written');
    assert.equal((await repl.run('listeners #nope')).status, 'error');
    assert.match((await repl.run('snapshot e99999')).output, /e99999 is a snapshot ref; if the page changed since that snapshot, take a new one/);
  });

  it('says a snapshot ref that no longer matches may be stale', async () => {
    const result = await repl.run('click e99999');
    assert.equal(result.status, 'error');
    assert.match(result.output, /e99999 is a snapshot ref; if the page changed since that snapshot, take a new one\./);
  });

  it('outlines the page and clicks by snapshot label', async () => {
    await ok('fill #name Lin');
    const snap = await ok('snapshot');
    assert.match(snap, /heading "Fixture"/);
    const ref = /button "Go" \[ref=((?:f\d+)?e\d+)\]/.exec(snap)[1];
    await ok(`click ${ref}`);
    await ok(`click aria-ref=${ref}`);
    assert.equal(await ok('text #out'), 'Hello Lin');
    assert.match(await ok('snapshot #go'), /button "Go"/);
  });

  it('keeps the refs of a whole-page snapshot after a snapshot of one element', async () => {
    const snap = await ok('snapshot');
    const results = /region "Results" \[ref=((?:f\d+)?e\d+)\]/.exec(snap)[1];
    const go = /button "Go"[^\n]* \[ref=((?:f\d+)?e\d+)\]/.exec(snap)[1];
    const part = await ok(`snapshot ${results}`);
    assert.match(part, /^- region "Results" \[ref=\S+\]:\n  - alert/);
    assert.doesNotMatch(part, /button "Go"/);
    assert.equal(await ok(`text ${go}`), 'Go', 'a ref outside that element still works');
  });

  it('watches alongside another Playwright client without throwing errors into the page', async () => {
    const { chromium } = require('playwright-core');
    const other = await chromium.connectOverCDP(chrome.cdpUrl);
    try {
      await ok(`tab new ${site.url}/?other-client`);
      const page = other.contexts()[0].pages().find(p => p.url().includes('other-client'));
      let called = 0;
      await page.exposeBinding('__otherTool', () => { called += 1; return 'ok'; });
      await ok('watch on');
      assert.equal(await ok('eval window.__otherTool()'), 'ok');
      await ok('click #go');
      await waitFor(async () => /click button "Go"/.test(await ok('watch')), 'the click');
      assert.equal(called, 1);
      assert.doesNotMatch(await ok('console 50'), /is not exposed/);
    } finally {
      await ok('watch off');
      await other.close();
      await ok('tab close other-client');
      await ok('tab 1');
    }
  });

  it('takes playwright-cli\'s command names, and says what they are here', async () => {
    await ok(`goto ${site.url}/`);
    await ok(`goto ${site.url}/other`);
    assert.match(await ok('go-back'), /^\(playwright-cli's go-back is back here\)\nBack to: /);
    await ok('go-forward');
    assert.match(await ok('go-back'), /^Back to: /, 'explained once');
    assert.match((await repl.runAs('cli-note', 'go-forward')).output, /^\(playwright-cli's go-forward is forward here\)/, 'and once to each client');
    await repl.runAs('cli-note', 'go-back');
    assert.equal(await ok('eval () => document.title'), 'Fixture', 'a function is called, as playwright-cli\'s eval does');
    await ok('route **/api/data --status=503 --body={"cli":1}');
    assert.match(await ok(fetchStatus), /^Faked: #\d+ GET \S+\/api\/data -> 503\n503$/);
    const { spawnSync } = require('child_process');
    const bin = require('path').join(__dirname, '..', 'bin', 'pw-repl.js');
    const sent = spawnSync(process.execPath, [bin, 'send', '-e', repl.socket, 'route', '**/api/data', '--body={"mock": true}'], { encoding: 'utf8' });
    assert.equal(sent.status, 0, sent.stdout);
    assert.match(await ok('eval fetch("/api/data").then(r => r.status)'), /-> 200\n200$/, 'a body with spaces, through send, at status 200');
    await ok('unroute');
    await ok('network-state-set offline');
    assert.match(await ok(fetchStatus), /Failed to fetch/);
    await ok('network-state-set online');
    const refused = await repl.run('run-code async page => 1');
    assert.equal(refused.status, 'error');
    assert.match(refused.output, /run-code is playwright-cli's; here, eval <JavaScript>/);
  });

  it('reads and writes storage, traces and records with playwright-cli\'s names', async () => {
    // A tab of its own: the recording must not leave steps in the tab later tests watch.
    await ok(`tab new ${site.url}/?cli-storage`);
    try {
      assert.equal(await ok('localstorage-set "cli key" a value'), '(playwright-cli\'s localstorage-set is eval localStorage.setItem("<key>", "<value>") here)\nSet cli key');
      assert.equal(await ok('localstorage-get "cli key"'), '(playwright-cli\'s localstorage-get is eval localStorage.getItem("<key>") here)\na value');
      assert.equal(await ok('localstorage-delete "cli key"'), '(playwright-cli\'s localstorage-delete is eval localStorage.removeItem("<key>") here)\nDeleted cli key');
      const { spawnSync } = require('child_process');
      const bin = require('path').join(__dirname, '..', 'bin', 'pw-repl.js');
      const sent = spawnSync(process.execPath, [bin, 'send', '-e', repl.socket, 'localstorage-set', 'my key', 'v'], { encoding: 'utf8' });
      assert.match(sent.stdout, /Set my key$/m, 'through send, a key with a space stays one');
      assert.equal(await ok('eval localStorage.getItem("my key")'), 'v');
      await ok('localstorage-delete "my key"');
      await ok('sessionstorage-set s 1');
      assert.match(await ok('sessionstorage-list'), /"s"/);
      await ok('sessionstorage-clear');
      assert.match(await ok('tracing-start'), /Capturing requests and console/);
      assert.match(await ok('tracing-stop'), /capture off, which prints what it recorded/);
      assert.match(await ok('recording-start'), /Watching the selected tab/);
      await ok('click #go');
      await waitFor(async () => /click button "Go"/.test(await ok('watch')), 'the click');
      const stopped = await ok('recording-stop');
      assert.match(stopped, /Stopped watching the selected tab[\s\S]*click button "Go"/, 'stopped, then the steps shown');
    } finally {
      await ok('tab close cli-storage');
    }
  });

  it('opens a tab with playwright-cli\'s open, emulating a phone before the page loads', async () => {
    const as = (client, command) => repl.runAs(client, command);
    try {
      const opened = await as('cli-open', `open ${site.url}/?cli-open --device="iPhone 13"`);
      assert.equal(opened.status, 'ok', opened.output);
      assert.match(opened.output, /Emulating mobile \(iPhone 13,/);
      assert.doesNotMatch(opened.output, /reload to see/, 'the page loads after, so nothing needs reloading');
      assert.equal((await as('cli-open', 'eval navigator.userAgent.includes("iPhone")')).output, 'true', 'the page loaded as the phone');
      const bad = await as('cli-open', 'open --device=nokia-3310');
      assert.equal(bad.status, 'error');
      assert.match(bad.output, /No device "nokia-3310"[\s\S]*The new tab stays open and selected; tab close closes it\./);
      assert.match((await as('cli-open', 'open')).output, /New tab created and selected/);
    } finally {
      await as('cli-open', 'close');
      for (let i = 0; i < 3; i++) await as('cli-open', 'tab close');
    }
  });

  it('selects a tab by index only with playwright-cli\'s tab-select, and closes nothing with close', async () => {
    const as = (client, command) => repl.runAs(client, command);
    try {
      assert.equal((await as('cli-a', `tab new ${site.url}/?cli-a`)).status, 'ok');
      const listed = (await ok('tab')).split('\n').filter(line => /^[ *] \[\d+\]/.test(line));
      const index = listed.findIndex(line => line.includes('?cli-a'));
      const other = listed.findIndex(line => !line.includes('?cli-a'));
      const fresh = await as('cli-b', `tab-select ${index}`);
      assert.match(fresh.output, /\?cli-a$/m, 'a new client, with no listing of its own, gets the tab at that index');
      const port = new URL(site.url).port;
      const missing = await as('cli-b', `tab-select ${port}`);
      assert.equal(missing.status, 'error');
      assert.match(missing.output, /No tab \[\d+\] in your last listing; tab-list lists them again/, 'never a tab whose URL contains the number');
      await as('cli-a', 'emulate dark');
      await as('cli-b', `tab-select ${other}`);
      await as('cli-b', 'network off');
      const closed = await as('cli-a', 'close');
      assert.equal(closed.status, 'ok', closed.output);
      assert.match(closed.output, /: emulate off$/m);
      assert.match(closed.output, /Tabs you opened are still open: \S+\?cli-a; tab close <url-part> closes one, or select it and tab close\./);
      assert.match(await ok('tab'), /\?cli-a/, 'its tab stays open');
      assert.match(await ok('modes'), /network:off/, 'another client\'s modes stay on');
      const unnamed = await repl.run('close');
      assert.equal(unnamed.status, 'error');
      assert.match(unnamed.output, /needs a client name: pw-repl send -c <name> close/);
    } finally {
      await as('cli-b', 'modes off --mine');
      await repl.run('tab close cli-a');
    }
  });

  it('selects the tab at an index in the sender\'s last listing with tab-select, even after tabs close', async () => {
    const as = (client, command) => repl.runAs(client, command);
    try {
      await as('cli-x', `tab new ${site.url}/?cli-x`);
      await as('cli-x', `tab new ${site.url}/?cli-y`);
      const seen = (await as('cli-d', 'tab-list')).output.split('\n').filter(line => /^[ *] \[\d+\]/.test(line));
      const [x, y] = ['?cli-x', '?cli-y'].map(part => seen.findIndex(line => line.includes(part)));
      await ok('tab close cli-x');
      assert.match((await as('cli-d', `tab-select ${y}`)).output, /\?cli-y$/m, 'the tab it listed, though one before it closed');
      assert.match((await as('cli-d', `tab-select ${x}`)).output, /The tab at \[\d+\] in your last listing has closed; tab-list lists them again/);
    } finally {
      await repl.run('tab close cli-y');
    }
  });

  it('keeps a selected tab per client, and says who turned each mode on', async () => {
    const as = async (client, command) => {
      const result = await repl.runAs(client, command);
      assert.equal(result.status, 'ok', `${client}: ${command}\n${result.output}`);
      return result.output;
    };
    const start = repl.stdout.length;
    const before = (await ok('info')).split('\n')[0];
    try {
      await as('agent-a', `tab new ${site.url}/?client-a`);
      await as('agent-b', `tab new ${site.url}/?client-b`);
      assert.match(await as('agent-a', 'info'), /\?client-a$/m, 'a keeps its tab while b opens one');
      assert.match(await as('agent-b', 'info'), /\?client-b$/m);
      assert.equal((await ok('info')).split('\n')[0], before, 'the unnamed senders and the prompt keep theirs');
      await as('agent-a', 'network off');
      await as('agent-b', 'route **/nothing 500 {}');
      await as('agent-b', 'tab client-a');
      await as('agent-b', 'emulate dark');
      const modes = await ok('modes');
      assert.match(modes, /\?client-a +\(network:off emulate:dark\)\n +on by agent-a: network:off; agent-b: emulate$/m);
      assert.match(modes, /\?client-b +\(routes:1\)\n +on by agent-b: route \*\*\/nothing$/m);
      assert.match(await ok('tab'), /\?client-a  \(opened by agent-a\)$/m);
      assert.match(repl.stdout.slice(start), /\[server:agent-a\] tab new /, 'the pane says who sent it');
      assert.match(await as('agent-a', 'modes off --mine'), /client-a: network on$/m);
      const left = await ok('modes');
      assert.match(left, /emulate:dark/, 'b\'s modes stay on');
      assert.doesNotMatch(left, /network:off/);
      assert.match(await as('agent-a', 'modes off --mine'), /None of your modes were on/);
      await as('agent-b', 'modes off --mine');
      assert.match(await ok('modes'), /No modes are on/);
      assert.equal((await repl.runAs('bad name', 'info')).code, 400, 'a client name has no spaces');
      const { spawnSync } = require('child_process');
      const bin = require('path').join(__dirname, '..', 'bin', 'pw-repl.js');
      const sent = spawnSync(process.execPath, [bin, 'send', '-e', repl.socket, '-c', 'agent-c', 'tab'], { encoding: 'utf8', env: { ...process.env, PW_CLIENT: '' } });
      assert.equal(sent.status, 0, sent.stderr);
      await waitFor(() => /\[server:agent-c\] tab/.test(repl.stdout.slice(start)), 'send -c to name the client');
      const byEnv = spawnSync(process.execPath, [bin, 'send', '-e', repl.socket, 'tab'], { encoding: 'utf8', env: { ...process.env, PW_CLIENT: 'agent-d' } });
      assert.equal(byEnv.status, 0, byEnv.stderr);
      await waitFor(() => /\[server:agent-d\] tab/.test(repl.stdout.slice(start)), 'PW_CLIENT to name the client');
      assert.equal(spawnSync(process.execPath, [bin, 'send', '-e', repl.socket, '-c', 'no/slash', 'info'], { encoding: 'utf8' }).status, 64);
    } finally {
      for (const part of ['client-a', 'client-b']) await repl.run(`tab close ${part}`);
    }
  });

  it('turns off only the sender\'s route, watch and capture with modes off --mine', async () => {
    const as = async (client, command) => {
      const result = await repl.runAs(client, command);
      assert.equal(result.status, 'ok', `${client}: ${command}\n${result.output}`);
      return result.output;
    };
    await as('mine-a', `tab new ${site.url}/?mine-a`);
    await as('mine-a', 'route **/a-only 500 {}');
    await as('mine-a', 'watch on');
    await as('mine-a', 'capture on');
    await as('mine-b', 'tab mine-a');
    await as('mine-b', 'route **/b-only 500 {}');
    assert.match(await as('mine-b', 'modes off --mine'), /\?mine-a: 1 route removed$/m);
    const left = await ok('modes');
    assert.match(left, /on by mine-a: watch, route \*\*\/a-only, capture$/m, 'a\'s stay on');
    assert.doesNotMatch(left, /b-only/);
    assert.match(await as('mine-a', 'modes off --mine'), /\?mine-a: watch off, capture off \(capture shows it\), 1 route removed$/m);
    assert.match(await ok('modes'), /No modes are on/);
  });

  it('hooks each page once, however often its tab is selected or watched', async () => {
    const start = repl.stdout.length;
    // Selected again, by this client and by others: each select must not hook it again.
    for (const client of ['once-a', 'once-b']) assert.equal((await repl.runAs(client, 'tab 127.0.0.1')).status, 'ok');
    await ok('tab 127.0.0.1');
    await ok('watch on');
    await ok('watch off');
    await ok('watch on');
    await ok('click #load');
    await waitFor(async () => /#\d+ GET 200 \S+\/api\/data/.test(await ok('watch')), 'the click and its request');
    assert.equal((await ok('watch 50')).match(/click button "Load"/g).length, 1, 'one step for one click');
    assert.equal((await ok('requests 50 /api/data')).match(/\/api\/data$/gm).length, 1, 'one entry for one request');
    await ok('click #noisy');
    await waitFor(async () => /boom-uncaught/.test(await ok('console 50')), 'the page error');
    assert.equal((await ok('console 50')).match(/hello-log/g).length, 1, 'one message for one console.log');
    const click = repl.run('click #alerter');
    await waitFor(() => /Dialog \[confirm\]: sure\?/.test(repl.stdout.slice(start)), 'the dialog');
    await ok('dialog accept');
    assert.equal((await click).status, 'ok');
    assert.equal(repl.stdout.slice(start).match(/Dialog \[confirm\]: sure\?/g).length, 1, 'one notice for one dialog');
  });

  it('watches the next tab someone opens, from its first page', async () => {
    const { chromium } = require('playwright-core');
    const person = await chromium.connectOverCDP(chrome.cdpUrl);
    try {
      assert.match(await ok('watch on --next-tab ?wanted'), /^Waiting to watch the next tab that opens with a URL containing \?wanted: /);
      assert.match(await ok('modes'), /^Waiting to watch the next tab that opens with a URL containing \?wanted \(watch off stops waiting\)/);
      const other = await person.contexts()[0].newPage();
      await other.goto(`${site.url}/?not-this-one`);
      const wanted = await person.contexts()[0].newPage();
      await wanted.goto(`${site.url}/?wanted`);
      await waitFor(async () => /\?wanted$/m.test(await ok('info').then(t => t.split('\n')[0])), 'the wanted tab to be selected');
      await wanted.click('#go');
      let trail = '';
      await waitFor(async () => /click button "Go"/.test(trail = await ok('watch')), 'the click in the new tab');
      assert.match(trail, /^\S+ navigate \S+\/\?wanted$/m, 'from its first page');
      assert.doesNotMatch(trail, /about:blank|not-this-one/);
      // Its first page can load before the watch is ready; its body is kept all the same.
      const first = trail.match(/#(\d+) GET 200 \S+\/\?wanted$/m)[1];
      await wanted.goto(`${site.url}/other?wanted`);
      assert.match(await ok(`body ${first}`), /\(text\/html, \d+ bytes\)\n[\s\S]*<title>Fixture<\/title>/);
      assert.doesNotMatch(await ok('modes'), /Waiting to watch/, 'it waits for one tab only');
      await ok('tab not-this-one');
      assert.match(await ok('watch'), /^Not watching the selected tab\./, 'a tab that is not it is left alone');
      await ok('tab ?wanted');
      await ok('watch off');
      await ok('watch on --next-tab');
      await repl.runAs('cli-own', `tab new ${site.url}/?own-tab`);
      assert.match(await ok('modes'), /Waiting to watch the next tab/, 'a tab a client opens with tab new is its own, not someone\'s');
      assert.match(await ok('watch off'), /^Stopped waiting to watch a new tab/);
      await repl.runAs('cli-waiting', 'watch on --next-tab ?never');
      const waiting = await repl.runAs('cli-waiting', 'watch new');
      assert.equal(waiting.status, 'ok', waiting.output);
      assert.match(waiting.output, /^Waiting to watch the next tab that opens with a URL containing \?never \(watch on --next-tab\); it is selected once it opens/);
      await repl.runAs('cli-waiting', 'watch off');
    } finally {
      await person.close();
      for (const part of ['not-this-one', '?wanted', '?own-tab']) await repl.run(`tab close ${part}`);
      await ok('tab 1');
    }
  });

  it('watches what happens in a tab, with the requests each step caused', async () => {
    assert.match(await ok('watch'), /^Not watching the selected tab\.\n\n +watch on +record/);
    await ok('watch on');
    assert.match(await ok('watch'), /^Watching the selected tab since \S+: nothing has happened yet\n[\s\S]*watch off/);
    await ok('fill #name secret-value');
    await ok('fill #pw hunter2');
    await ok('click #load');
    let trail = '';
    await waitFor(async () => /#\d+ GET 200 \S+\/api\/data/.test(trail = await ok('watch')), 'the click and its request');
    assert.match(trail, /type textbox "Name"/);
    assert.match(trail, /click button "Load"\n +#\d+ GET 200 \S+\/api\/data/);
    assert.doesNotMatch(trail, /secret-value|hunter2|Password/);
    await ok(`goto ${site.url}/`);
    await waitFor(async () => /navigate http/.test(await ok('watch')), 'the navigation');
    await ok('click #go');
    await waitFor(async () => /click button "Go"/.test(await ok('watch')), 'a click after navigating');
    await ok('click #pw');
    await ok('click #typed');
    await ok('eval window.__pwReplWatch(JSON.stringify({ action: "navigate", target: "forged-navigation" }))');
    await ok('eval window.__pwReplWatch(JSON.stringify({ action: "click", target: "forged-click", t: 0 }))');
    await waitFor(async () => /forged-click/.test(trail = await ok('watch 50')), 'the page-sent click');
    assert.doesNotMatch(trail, /Password|my private draft|forged-navigation/);
    assert.match(trail, /click p\n/, 'an editable area is named by role only');
    assert.doesNotMatch(trail, /00:00:00\.000/, 'the page cannot set the time');
    await ok('watch off');
    await ok('click #load');
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await ok('watch 50')).match(/click button "Load"/g).length, 1);
    assert.match(await ok('watch 50'), /\[watch is off\]/);
    const bare = await ok('watch');
    assert.match(bare, /^Not watching the selected tab; \d+ steps recorded before watch off:\n/);
    assert.match(bare, /click button "Load"[\s\S]*\n\n +watch <n> [^\n]*\n +watch on \[--changes\] \[--live\] +record again$/);
  });

  it('keeps the bodies of what a watch shows, after the tab navigates', async () => {
    await ok(`tab new ${site.url}/?kept-bodies`);
    const lastApiCall = async () => {
      let last = '';
      await waitFor(async () => / 200 .*\/api\/data$/.test(last = (await ok('requests /api/data')).trim().split('\n').pop()), 'the request');
      return last.match(/#\d+/)[0];
    };
    await ok('click #load');
    const unwatched = await lastApiCall();
    await ok(`goto ${site.url}/other`);
    const dropped = await repl.run(`body ${unwatched}`);
    assert.equal(dropped.status, 'error');
    assert.match(dropped.output, /not available: .*a watched tab keeps them as they arrive/);
    await ok('back');
    await ok('watch on');
    await ok('click #load');
    const watched = await lastApiCall();
    await ok(`goto ${site.url}/other`);
    assert.match(await ok(`body ${watched}`), /GET 200 \S+\/api\/data \(application\/json, 13 bytes\)\n\{\n  "real": true\n\}/);
    // A page that navigates as soon as a request answers, as after a login: it is never reported finished.
    await ok('back');
    await ok('eval fetch("/api/data").then(r => r.json()).then(() => { location.href = "/other?after-fetch"; }); 0');
    await waitFor(async () => /after-fetch/.test(await ok('info')), 'the navigation');
    const left = (await ok('requests /api/data')).trim().split('\n').pop().match(/#\d+/)[0];
    assert.match(await ok(`body ${left}`), /GET 200 \S+\/api\/data \(application\/json, 13 bytes\)\n\{\n  "real": true\n\}/);
    await ok('watch off');
    await ok('tab close');
  });

  it('records typing before the step that follows it, and names a select by its label', async () => {
    await ok('reload');
    await ok('watch on');
    await ok('fill #name Ada');
    await ok('select #color Blue');
    let trail = '';
    await waitFor(async () => /select combobox/.test(trail = await ok('watch')), 'the select');
    assert.match(trail, /type textbox "Name"\n\S+ select combobox "Color" "Blue"/);
    await ok('watch off');
  });

  it('records typing once it pauses, and Enter and Escape, without the values', async () => {
    await ok('watch on');
    assert.match(await ok('watch'), /: nothing has happened yet\n/, 'watch on after watch off starts a new recording');
    assert.equal(await ok('watch new'), 'Watching; nothing has happened yet');
    await ok('watch new');
    await ok('type #name abc');
    await new Promise(r => setTimeout(r, 900));
    await ok('type #name def');
    await ok('press #name Enter');
    await ok('press Escape');
    await ok('type #pw hunter2');
    await ok('press #pw Enter');
    await ok('press #go Enter');
    let trail = '';
    await waitFor(async () => /press/.test(trail = (trail + '\n' + await ok('watch new'))) && /Escape/.test(trail), 'the key presses');
    await new Promise(r => setTimeout(r, 900));
    trail += '\n' + await ok('watch new');
    assert.equal(trail.match(/type textbox "Name"/g).length, 2, trail);
    assert.match(trail, /type textbox "Name"\n\S+ press textbox "Name" Enter/, 'typing is recorded before the Enter that ends it');
    assert.match(trail, /press \S+.* Escape/);
    assert.doesNotMatch(trail, /abc|def|hunter2|Password|fill textbox "Name"/);
    assert.doesNotMatch(trail, /press button/, 'Enter on a button is left to the click it causes');
    await ok('watch off');
  });

  it('shows only new steps with watch new, and requests that came after a step was read', async () => {
    await ok('watch on');
    assert.equal(await ok('watch new'), 'Watching; nothing has happened yet');
    await ok('route **/api/slow 200 {"slow":true}');
    await ok('eval document.querySelector("#load").onclick = () => setTimeout(() => fetch("/api/slow"), 400)');
    await ok('click #load');
    let first = '';
    await waitFor(async () => /click button "Load"/.test(first = await ok('watch new')), 'the click');
    assert.doesNotMatch(first, /api\/slow/);
    let late = '';
    await waitFor(async () => /api\/slow/.test(late = await ok('watch new')), 'the late request');
    assert.match(late, /click button "Load" \(continued\)\n +#\d+ GET 200 faked \S+\/api\/slow/);
    assert.equal(await ok('watch new'), 'No new steps');
    await ok('route off **/api/slow');
    await ok('reload');
    await ok('watch off');
  });

  it('adds what each step changed on screen with watch on --changes, without typed values', async () => {
    await ok('reload');
    await ok('watch on --changes');
    await ok('watch new');
    await ok('type #name zzz-typed');
    await new Promise(r => setTimeout(r, 2000));
    const typed = await ok('watch new');
    assert.match(typed, /type textbox "Name"/);
    assert.doesNotMatch(typed, /zzz-typed/);
    await ok('click #go');
    let trail = '';
    await waitFor(async () => /Hello/.test(trail += '\n' + await ok('watch new')), 'the change the click made', 6000);
    assert.match(trail, /click button "Go"(?: \(continued\))?\n +[+~] .*Hello zzz-typed/);
    await ok('watch on');
    await ok('click #go');
    await new Promise(r => setTimeout(r, 1500));
    assert.doesNotMatch(await ok('watch new'), /^ +[+~-] /m, 'plain watch on shows no changes');
    await ok('watch off');
  });

  it('never names a step from the text of an editable area', async () => {
    await ok('reload');
    await ok('watch on');
    await ok('watch new');
    await ok('eval document.activeElement.blur()');
    await ok('press Escape');
    await ok('click body');
    let trail = '';
    await waitFor(async () => /Escape/.test(trail += '\n' + await ok('watch new')) && /click/.test(trail), 'the Escape and the click');
    assert.match(trail, /press page Escape/);
    assert.doesNotMatch(trail, /my private draft/);
    await ok('watch off');
  });

  it('leaves out text typed into an editable area with --changes', async () => {
    await ok('reload');
    await ok('watch on --changes');
    await ok('watch new');
    await ok('click #typed');
    await ok('type #composer CESECRET');
    await new Promise(r => setTimeout(r, 1500));
    await ok('fill #name Kim');
    await ok('click #go');
    let trail = '';
    await waitFor(async () => /Hello Kim/.test(trail += '\n' + await ok('watch new')), 'the change the click made', 6000);
    assert.match(trail, /type div\n/, `the typing is recorded:\n${trail}`);
    assert.doesNotMatch(trail, /CESECRET|my private draft/);
    await ok('watch off');
  });

  it('shows changes on every plain watch, and leaves watch new its own place', async () => {
    await ok('reload');
    await ok('watch on --changes');
    await ok('watch new');
    await ok('fill #name Quinn');
    await ok('click #go');
    await waitFor(async () => /Hello Quinn/.test(await ok('watch')), 'the change', 6000);
    assert.match(await ok('watch'), /Hello Quinn/, 'shown again');
    const fresh = await ok('watch new');
    assert.match(fresh, /click button "Go"/, 'plain watch did not mark it read');
    assert.match(fresh, /Hello Quinn/);
    assert.doesNotMatch(await ok('watch new'), /Hello Quinn/);
    await ok('watch off');
  });

  it('prints each step as it happens with watch on --live', async () => {
    await ok('reload');
    assert.match(await ok('watch on'), /watch on --live also prints each step/);
    assert.match(await ok('watch on --live'), /Each step prints here once it settles/);
    const start = repl.stdout.length;
    await ok('click #load');
    await waitFor(() => /\[watch\] \S+ click button "Load"\n {8}\s+#\d+ GET 200 \S+\/api\/data/.test(repl.stdout.slice(start)), 'the step with its request', 6000);
    await ok('click #go');
    await ok('click #load');
    await waitFor(() => /\[watch\] \S+ click button "Go"[\s\S]*\[watch\] \S+ click button "Load"/.test(repl.stdout.slice(start)), 'a step ended by the next one, then that one', 6000);
    assert.match(await ok('watch'), /^Watching the selected tab since \S+ \(live\): /);
    assert.match(await ok('watch off'), /; \d+ steps recorded \(watch shows them\)$/);
    const after = repl.stdout.length;
    await ok('click #go');
    await new Promise(r => setTimeout(r, 1500));
    assert.doesNotMatch(repl.stdout.slice(after), /\[watch\]/, 'nothing prints once watch is off');
  });

  it('prints live steps with their changes, outside any command\'s answer', async () => {
    await ok('reload');
    assert.match(await ok('watch off'), /^Not watching the selected tab\.$/, 'watch off when not watching says so');
    await ok('watch on --changes --live');
    const start = repl.stdout.length;
    await ok('fill #name Pat');
    await ok('click #go');
    const answer = await ok('sleep 2500');
    assert.doesNotMatch(answer, /\[watch/, 'not part of the answer to the command running then');
    await waitFor(() => /\[watch\] \S+ click button "Go"(?:\n {8}.*)*?\n {8} +[+~] .*Hello Pat/.test(repl.stdout.slice(start)), 'the step with its change', 6000);
    await ok('watch off');
  });

  it('names the tab of a live step when it is not the selected one', async () => {
    await ok('reload');
    await ok('watch on --live');
    await ok('eval setTimeout(() => document.querySelector("#go").click(), 1000); "later"');
    await ok(`tab new ${site.url}/?elsewhere`);
    const start = repl.stdout.length;
    await waitFor(() => /\[watch 127\.0\.0\.1:\d+\/\] \S+ click button "Go"/.test(repl.stdout.slice(start)), 'the step, named by its tab', 6000);
    await ok('tab close');
    await ok('watch off');
  });

  it('waits for text, and for a response even if it already arrived', async () => {
    await ok('fill #name Wu');
    await ok('click #go');
    assert.match(await ok('wait text "Hello Wu" 5'), /Visible: Hello Wu/);
    await ok('click #load');
    await new Promise(r => setTimeout(r, 300));
    assert.match(await ok('wait request /api/data 5'), /#\d+ GET 200 \S+\/api\/data/);
    await ok('click #load');
    assert.match(await ok('wait request **/api/* 5'), /\/api\/data/, 'globs work too');
    const late = await repl.run('wait request /never 1');
    assert.equal(late.status, 'error');
    const never = await repl.run('wait text "never shown" 1');
    assert.equal(never.output, 'Error: No visible text matches never shown within 1s', 'said plainly');
    assert.equal((await repl.run('wait #never 1')).output, 'Error: No visible element matches #never within 1s');
    await ok('eval document.body.insertAdjacentHTML("beforeend", \'<p id="later" hidden>Later</p>\'); setTimeout(() => { document.querySelector("#later").hidden = false; }, 400); "added"');
    assert.equal(await ok('wait #later 5'), 'Visible: #later', 'a hidden element is waited for until it shows');
    assert.match(await ok('info'), /Title: Fixture$/m, 'a wait that times out does not disconnect');
  });

  it('waits for the page to load, counting a navigation that just began', async () => {
    await ok('eval setTimeout(() => { location.href = "/slow-load"; }, 0); "leaving"');
    assert.match(await ok('wait load 5'), /^Loaded: \S+\/slow-load — Slow$/);
    assert.equal(await ok('eval document.readyState'), 'complete');
    assert.match(await ok('wait load 1'), /^Loaded before the previous command, nothing since: \S+\/slow-load — Slow\n/, 'a page that has loaded is done at once, and says it is not a new load');
    // An app's own routing changes the URL a moment later, without a load: the page being left is not reported as a new load.
    await ok('eval setTimeout(() => history.pushState({}, "", "/routed"), 300); "routing"');
    assert.match(await ok('wait load 1'), /^Loaded before the previous command, nothing since: \S+\/slow-load — Slow\n\(A page that changes its own URL does not load/);
    assert.equal((await repl.run('wait load --gone')).status, 'error');
    await ok(`goto ${site.url}/`);
    // Chrome answers a link to a 204 by staying put, and reports it as aborted.
    await ok('eval document.body.insertAdjacentHTML("beforeend", \'<a id="to-empty" href="/api/empty">empty</a>\'); 0');
    await ok('click #to-empty');
    const started = Date.now();
    const stayed = await repl.run('wait load 5');
    assert.equal(stayed.status, 'error');
    assert.match(stayed.output, /The page did not load: #\d+ \S+\/api\/empty 204 \(no page to show, so the tab stays where it was\)/);
    assert.ok(Date.now() - started < 3000, 'at once, not at the end of the wait');
    const went = await repl.run(`goto ${site.url}/api/empty`);
    assert.equal(went.output, `Error: The page did not load: #${/#(\d+) \S+\/api\/empty/.exec(went.output)?.[1]} ${site.url}/api/empty 204 (no page to show, so the tab stays where it was)`, 'goto says it as wait load does');
    assert.doesNotMatch(await ok('requests 3 /api/empty'), /--- the page loads \S+\/api\/empty/, 'no load marked where none happened');
  });

  it('says sleep takes milliseconds when the number looks like seconds', async () => {
    assert.equal(await ok('sleep 3'), 'Slept 3ms (sleep takes milliseconds: sleep 3000 is 3s)');
    assert.equal(await ok('sleep 150'), 'Slept 150ms');
  });

  it('waits for an element or text to be gone', async () => {
    await ok('eval (() => { const s = document.createElement("p"); s.className = "spin"; s.textContent = "Loading now"; document.body.append(s); setTimeout(() => { s.hidden = true; }, 300); setTimeout(() => s.remove(), 600); return "added"; })()');
    assert.match(await ok('wait .spin --gone 5'), /^Gone: \.spin$/);
    assert.match(await ok('wait text "Loading now" --gone 5'), /^Gone: Loading now$/);
    assert.match(await ok('wait .never-there --gone'), /Gone/, 'nothing matching is gone already');
    const stays = await repl.run('wait h1 --gone 1');
    assert.equal(stays.status, 'error');
    assert.match(stays.output, /Still visible after 1s: h1/);
  });

  it('chooses files in a file input, a hidden one behind a button, and from send\'s folder', async () => {
    const os = require('os');
    const path = require('path');
    const { spawnSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-repl-upload-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
      fs.writeFileSync(path.join(dir, 'b c.png'), Buffer.alloc(3));
      const file = path.join(dir, 'a.txt');
      assert.match((await repl.run(`upload ${file}`)).output, /Usage: upload <selector> <file>\.\.\., naming the file input \(or the button that opens it\) first, e\.g\. upload e12 \.\/doc\.pdf/);
      assert.match((await repl.run(`upload ${file} ${file}`)).output, /a\.txt is a file, not the input: upload <selector> <file>/, 'playwright-cli\'s upload <files...>');
      assert.doesNotMatch((await repl.run(`upload //input[@id="files"] ${file}`)).output, /is a file, not the input/, 'an XPath is a selector');
      await ok('eval document.body.insertAdjacentHTML("beforeend", \'<input type="file" id="files" multiple><input type="file" id="hidden" hidden><button id="pick" onclick="document.querySelector(\\\'#hidden\\\').click()">Pick</button>\'); "added"');
      const files = id => ok(`eval [...document.querySelector("#${id}").files].map(f => f.name + ":" + f.size + ":" + f.type).join(" ")`);
      assert.match(await ok(`upload #files ${dir}/a.txt "${dir}/b c.png"`), /^Chose 2 files in #files: /);
      assert.equal(await files('files'), 'a.txt:5:text/plain b c.png:3:image/png');
      assert.match(await ok(`upload #pick ${dir}/a.txt`), /^Chose a file in #pick: /);
      assert.equal(await files('hidden'), 'a.txt:5:text/plain', 'a button that opens the picker');
      const sent = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'pw-repl.js'), 'send', '-e', repl.socket, 'upload', '#files', 'b c.png'], { encoding: 'utf8', cwd: dir });
      assert.equal(sent.status, 0, sent.stdout + sent.stderr);
      assert.equal(await files('files'), 'b c.png:3:image/png', 'a relative path is from send\'s folder');
      const missing = await repl.run(`upload #files ${dir}/nope.txt`);
      assert.equal(missing.status, 'error');
      assert.match(missing.output, /Cannot read \S+\/nope\.txt: no such file/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await ok(`goto ${site.url}/`);
    }
  });

  it('emulates a phone, a color scheme, a locale and a timezone, and stops them', async () => {
    const read = 'eval [innerWidth, devicePixelRatio, matchMedia("(pointer: coarse)").matches, matchMedia("(prefers-color-scheme: dark)").matches, navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.userAgent.includes("Mobile")].join(" ")';
    const before = await ok(read);
    assert.match(await ok('emulate'), /^Nothing is emulated in the selected tab\.\n\n +emulate mobile/);
    assert.match(await ok('emulate mobile'), /^Emulating mobile \(Pixel 7, 412x839 at 2\.625x, touch\) in the selected tab\nThe page sees its user agent/);
    await ok('emulate dark');
    await ok('emulate locale fr-fr');
    await ok('emulate timezone Asia/Tokyo');
    await ok('reload');
    assert.match(await ok(read), /^\d+ 2\.625 true true fr-FR Asia\/Tokyo true$/);
    assert.match(await ok('info'), /Viewport: 412x839 \(emulate mobile: Pixel 7[;)]/);
    const shot = /Saved: (\S+)/.exec(await ok('screenshot'))[1];
    assert.equal(require('path').dirname(shot), require('path').dirname(repl.socket), 'next to its own socket');
    // The page has no viewport meta tag, so it is laid out wider than the phone and shown shrunk. The
    // shot is of what the phone shows: a button's text is drawn where the button is, not left blank.
    const drawn = await ok(`eval (async () => { const img = new Image(); img.src = "data:image/png;base64,${fs.readFileSync(shot).toString('base64')}"; await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); const k = visualViewport.scale; const r = document.querySelector("#noisy").getBoundingClientRect(); const d = g.getImageData(r.x * k, r.y * k, r.width * k, r.height * k).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) dark += 1; return [img.width === Math.round(visualViewport.width * k), img.width, dark > 0].join(" "); })()`);
    assert.equal(drawn, 'true 412 true', 'the phone\'s width, the page shown shrunk as the phone shows it');
    assert.match(await ok('info'), /Viewport: 412x839 \(emulate mobile: Pixel 7; the page lays out \d+ wide, shown shrunk: it has no viewport meta tag\)/);
    fs.rmSync(shot);
    assert.match(await ok(read), /^\d+ 2\.625 /, 'a screenshot keeps the phone\'s screen');
    const ref = /heading "Fixture" \[level=1\] \[ref=((?:f\d+)?e\d+)\]/.exec(await ok('snapshot'))?.[1];
    // A space in the sender's folder, which send keeps in one word.
    const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'pw shot-'));
    try {
      const { spawnSync } = require('child_process');
      const bin = require('path').join(__dirname, '..', 'bin', 'pw-repl.js');
      const sent = spawnSync(process.execPath, [bin, 'send', '-e', repl.socket, 'screenshot', ref, '--filename=h1.jpg'], { encoding: 'utf8', cwd: dir });
      assert.equal(sent.status, 0, sent.stdout);
      const saved = require('path').join(dir, 'h1.jpg');
      assert.equal(sent.stdout.trim(), `Saved: ${saved}`, 'relative to the sender\'s folder');
      assert.equal(fs.readFileSync(saved).subarray(0, 2).toString('hex'), 'ffd8', 'a JPEG');
      assert.match((await repl.run(`screenshot --filename="${saved}"`)).output, /already exists/);
      const spaced = require('path').join(dir, 'a b');
      fs.mkdirSync(spaced);
      assert.match(await ok(`screenshot --full-page --filename="${require('path').join(spaced, 'page.png')}"`), /a b\/page\.png$/, 'a quoted path with a space');
      assert.match((await repl.run(`screenshot --filename "${require('path').join(spaced, 'nope', 'x.png')}"`)).output, /No folder [^\n]+a b\/nope to save x\.png in/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const shown = await ok('emulate');
    assert.match(shown, /^  mobile +Pixel 7, 412x839 at 2\.625x, touch$/m);
    assert.match(shown, /^  color scheme +dark$/m);
    assert.match(shown, /^  locale +fr-FR$/m);
    assert.match(shown, /^  timezone +Asia\/Tokyo$/m);
    assert.match(await ok('modes'), /\(emulate:mobile,dark,locale,timezone\)$/m);
    assert.match(await ok('emulate timezone Asia/Kolkata'), /^Emulating timezone Asia\/Kolkata /, 'named as given');
    assert.match(await ok('eval Intl.DateTimeFormat().resolvedOptions().timeZone'), /^Asia\/(?:Kolkata|Calcutta)$/);
    assert.match((await repl.run('viewport 800x600')).output, /emulate mobile off first/);
    await ok('emulate dark off');
    assert.match(await ok(read), / false fr-FR /, 'one stops, the others stay');
    await ok('emulate light');
    assert.match(await ok('eval matchMedia("(prefers-color-scheme: light)").matches'), /true/);
    assert.match(await ok('emulate mobile iphone 13'), /iPhone 13, 390x664/, 'device names in any case');
    assert.match(await ok('emulate mobile off'), /^Stopped emulating mobile in the selected tab\nThe page sees its own user agent, touch and languages again from its next load: reload/);
    await ok('emulate mobile iphone 13');
    const near = await repl.run('emulate mobile iphone pro');
    assert.match(near.output, /No device "iphone pro"; matching: (?:iPhone \d+ Pro(?: Max)?, )+/, 'a near miss lists the names it matches');
    assert.doesNotMatch(near.output, /landscape,/);
    for (const bad of ['emulate mobile Nokia 3310', 'emulate timezone Mars/Olympus', 'emulate locale 12345', 'emulate dark please', 'emulate sepia']) {
      assert.equal((await repl.run(bad)).status, 'error', bad);
    }
    assert.match(await ok('emulate off'), /Stopped emulating in the selected tab: mobile, light, locale, timezone/);
    await ok('reload');
    assert.equal(await ok(read), before, 'everything is back as it was');
    assert.match(await ok('modes'), /No modes are on/);
    await ok('emulate dark');
    assert.match(await ok('modes off'), /: emulate off$/m);
    assert.match(await ok('eval matchMedia("(prefers-color-scheme: dark)").matches'), /false/);
  });

  it('selects and closes tabs by a part of their URL', async () => {
    await ok(`tab new ${site.url}/?tab-test=one`);
    await ok('tab 1');
    assert.match(await ok('tab tab-test=one'), /tab-test=one/);
    const ambiguous = await repl.run(`tab ${site.url}`);
    assert.equal(ambiguous.status, 'error');
    assert.match(ambiguous.output, /tabs match/);
    await ok('tab 1');
    assert.match(await ok('tab close tab-test=one'), /Closed \S+tab-test=one/);
    const listing = await ok('tab');
    assert.doesNotMatch(listing, /tab-test=one/);
    assert.match(listing, /^\* \[1\] http:\/\/127\.0\.0\.1:\d+\/\n +"Fixture"$/m, 'the selected tab is marked');
    assert.match(listing, /\n\n +tab <index\|url-part> [^\n]*\n +tab new \[url\] +open a tab/);
    assert.match(await ok('info'), /URL: +\S+127\.0\.0\.1:\d+\/$/m, 'closing another tab keeps the selection');
  });

  it('assumes http:// for localhost, and shows the window size as the viewport', async () => {
    const port = new URL(site.url).port;
    assert.match(await ok(`goto localhost:${port}/`), /^http:\/\/localhost:\d+\/ — Fixture$/);
    assert.match(await ok('info'), /Viewport: \d+x\d+ \(the window's size\)$/m);
    await ok('viewport 900x700');
    assert.equal(await ok('viewport'), '900x700 (set with viewport)');
    await ok(`goto ${site.url}/`);
  });

  it('goes back to a page from the back/forward cache without waiting for loads that never come', async () => {
    await ok(`goto ${site.url}/`);
    await ok(`goto ${site.url}/other`);
    const started = Date.now();
    assert.match(await ok('back'), /^Back to: \S+\/$/);
    assert.ok(Date.now() - started < 2000, `back took ${Date.now() - started}ms`);
    await ok(`goto ${site.url}/`);
  });

  it('goes back and forward, and says when there is nowhere to go', async () => {
    await ok(`goto ${site.url}/`);
    await ok('click text=Other');
    await waitFor(async () => /\/other$/.test(await ok('info').then(t => t.split('\n')[0])), 'the other page');
    assert.match(await ok('back'), /^Back to: \S+\/$/);
    assert.match(await ok('forward'), /^Forward to: \S+\/other$/);
    await ok('tab new');
    const nowhere = await repl.run('back');
    assert.equal(nowhere.status, 'error');
    assert.match(nowhere.output, /No page to go back to/);
    await ok('tab close');
    await ok(`goto ${site.url}/`);
  });

  it('says a new tab whose page failed to load stays open and selected', async () => {
    const failed = await repl.run('tab new http://127.0.0.1:9/');
    assert.equal(failed.status, 'error');
    assert.match(failed.output, /The new tab stays open and selected; tab close closes it\./);
    await ok('tab close');
    assert.match(await ok('info'), /Title: Fixture$/m, 'back to the tab before');
  });

  it('greps the snapshot by role, name or flag, with where each hit sits', async () => {
    assert.match(await ok('snapshot --grep alert'), /region "Results" › alert \[ref=(?:f\d+)?e\d+\]: Could not load results\./);
    assert.match(await ok('snapshot --grep disabled'), /region "Results" › button "Refresh Results" \[disabled\] \[ref=(?:f\d+)?e\d+\]/);
    assert.match(await ok('snapshot --grep "refresh results"'), /Refresh Results/, 'any case, quotes allowed');
    assert.match(await ok('snapshot --grep "button \\"Refresh Results\\""'), /button "Refresh Results"/, 'escaped quotes, as typed in a shell');
    assert.match(await ok('snapshot --grep nothing-like-this'), /No snapshot lines match/);
    const ref = /button "Go" \[ref=((?:f\d+)?e\d+)\]/.exec(await ok('snapshot --grep "button \"Go\""'))[1];
    assert.match(await ok(`snapshot ${ref}`), /^- button "Go"/);
    assert.match(await ok('snapshot --regex "Refresh R\\w+"'), /button "Refresh Results"/, 'a regular expression');
    assert.match(await ok('snapshot --regex refresh'), /No snapshot lines match/, 'as written, case and all');
    assert.match((await repl.run('snapshot --regex (')).output, /Not a regular expression/);
    assert.match(await ok('find --regex R\\w+ Results'), /^\(playwright-cli's find --regex is snapshot --regex <pattern> here\)\n[\s\S]*Refresh Results/);
    assert.match(await ok('find --regex "Refresh R\\w+"'), /Refresh Results/, 'double-quoted, its backslashes kept');
    const { spawnSync } = require('child_process');
    const sent = spawnSync(process.execPath, [require('path').join(__dirname, '..', 'bin', 'pw-repl.js'), 'send', '-e', repl.socket, 'find', '--regex', 'Refresh R\\w+'], { encoding: 'utf8' });
    assert.match(sent.stdout, /Refresh Results/, 'through send, as split words');
  });

  it('after closing its own tab, goes back only to a tab it opened', async () => {
    await ok(`tab new ${site.url}/?first`);
    await ok(`tab new ${site.url}/?second`);
    await ok('tab close');
    assert.match(await ok('info'), /URL: +\S+\?first$/m, 'back to the tab it opened before');
    await ok('tab 0');
    await ok(`tab new ${site.url}/?third`);
    assert.match(await ok('tab close'), /no tab is selected now/, 'tab [0] was not opened by this REPL');
    const refused = await repl.run('info');
    assert.equal(refused.status, 'error');
    assert.match(refused.output, /No tab is selected/);
    assert.match(await ok('tab'), /No tab is selected/);
    await ok('tab close first');
    await ok('tab 1');
    assert.match(await ok('info'), /URL: +\S+127\.0\.0\.1:\d+\/$/m);
  });

  it('says where a REPL would connect when none is running', () => {
    const { spawnSync } = require('child_process');
    const path = require('path');
    const where = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'pw-repl.js'), 'where', '-e', path.join(path.dirname(repl.socket), 'none.sock')], { encoding: 'utf8', env: { ...process.env, PW_CDP_URL: chrome.cdpUrl } });
    assert.match(where.stdout, /^browser: \S+ answers \(.*; run and serve connect here without --launch\)$/m);
  });

  it('sends a CDP command', async () => {
    assert.match(await ok('cdp Runtime.evaluate {"expression":"6*7","returnByValue":true}'), /"value": 42/);
    assert.match((await repl.run('cdp Browser.close {}')).output, /reserved/);
  });

  it('caps long output unless --all is given', async () => {
    assert.match(await ok('eval "x".repeat(13000)'), /\[truncated; add --all to the command/);
    assert.doesNotMatch(await ok('eval --all "x".repeat(13000)'), /truncated/);
  });

  it('fakes a response in the browser and proves it', async () => {
    await ok('route **/api/data 503 {"detail":"down"}');
    const faked = await ok(fetchStatus);
    assert.match(faked, /Faked: #\d+ GET .*\/api\/data -> 503/);
    assert.match(faked, /^503$/m);
    assert.match(await ok('route'), /Routes on the selected tab \(1\):\n +\*\*\/api\/data +503 \{"detail":"down"\}\n\n +route <url-glob>[\s\S]*route off/);
    await ok('route off --all');
    assert.equal(await ok(fetchStatus), '200');
  });

  it('redraws the prompt after a fake that fires between commands', async () => {
    await ok('route **/api/data 503 {}');
    await ok('eval setTimeout(() => fetch("/api/data"), 200); "scheduled"');
    const start = repl.stdout.length;
    await waitFor(() => /Faked: #\d+ GET \S+\/api\/data -> 503\n\(routes:1\) pw\[serve\]> /.test(repl.stdout.slice(start)), 'the late Faked line and a fresh prompt');
    await ok('route off --all');
  });

  it('replaces, removes one, and keeps routes per tab', async () => {
    await ok('route **/api/data 503 {}');
    assert.match(await ok('route **/api/data 504 {}'), /Replaced/);
    await ok('route **/api/other 500 {}');
    assert.match(await ok(fetchStatus), /^504$/m);
    await ok('route off **/api/data');
    assert.doesNotMatch(await ok('route'), /api\/data/);
    assert.equal(await ok(fetchStatus), '200');
    await ok(`tab new ${site.url}/`);
    assert.match(await ok('route'), /No routes on the selected tab/);
    await ok('tab close');
    await ok('tab 1');
    assert.match(await ok('route'), /api\/other/);
    assert.equal((await repl.run('route off **/api/nothing')).status, 'error');
    await ok('route off --all');
  });

  it('patches a real JSON response, delays a request, and fails one', async () => {
    const json = 'eval fetch("/api/data").then(r => r.text())';
    assert.match(await ok('route **/api/data patch {"real":false,"added":{"n":1}}'), /Routed: \*\*\/api\/data -> patch/);
    const patched = await ok(json);
    assert.match(patched, /Patched: #\d+ GET \S+\/api\/data -> 200/);
    assert.match(patched, /^\{"real":false,"added":\{"n":1\}\}$/m);
    assert.match(await ok('requests 3 /api/data'), /GET 200 patched/);
    await ok('route **/api/data patch {"real":null}');
    assert.match(await ok(json), /^\{\}$/m, 'null removes a key');
    await ok('route **/api/data delay 1');
    assert.match(await ok('eval (async () => { const t = Date.now(); await fetch("/api/data"); return Date.now() - t >= 900; })()'), /^true$/m);
    await ok('route **/api/data abort');
    assert.match(await ok(fetchStatus), /Failed to fetch/);
    assert.match(await ok('route'), /\*\*\/api\/data +abort/);
    await ok('route off --all');
    assert.equal(await ok(fetchStatus), '200');
  });

  it('refuses statuses a response cannot have', async () => {
    assert.match((await repl.run('route **/x 101 {}')).output, /200 to 599/);
  });

  it('rejects a route body that is not JSON, unless its type is given', async () => {
    const result = await repl.run('route **/api/data 500 {nope');
    assert.equal(result.status, 'error');
    assert.match(result.output, /not valid JSON: .*; for another kind, give its type: route <url-glob> <status> --content-type=text\/plain <body>/);
    const text = 'eval fetch("/api/data").then(async r => `${r.status} ${r.headers.get("content-type")} ${await r.text()}`)';
    await ok('route "**/api/data" 503 --content-type=text/plain down for now');
    assert.match(await ok(text), /^503 text\/plain down for now$/m, 'a quoted glob matches as if unquoted');
    await ok('route **/api/data 200 --content-type="text/html; charset=utf-8" <p>hi</p>');
    assert.match(await ok(text), /^200 text\/html; charset=utf-8 <p>hi<\/p>$/m, 'a quoted type with a parameter');
    await ok('route **/api/data 204');
    assert.match(await ok(text), /^204 null $/m, 'no body');
    await ok('route off "**/api/data"');
  });

  it('shows a fake as faked in requests as soon as it is answered', async () => {
    await ok('route **/api/instant 418 {}');
    assert.match(await ok('eval fetch("/api/instant").then(r => r.status)'), /^418$/m);
    assert.match(await ok('requests 5 /api/instant'), /GET 418 faked \d+ms/);
    await ok('route off --all');
  });

  it('says when requests and console leave older ones out', async () => {
    await ok('eval Promise.all(Array.from({ length: 4 }, (_, i) => fetch("/api/data?cut=" + i)))');
    let listed = '';
    await waitFor(async () => /cut=3/.test(listed = await ok('requests 2 cut=')), 'the requests');
    assert.match(listed, /^\(last 2 of 4 kept; requests 4 cut= shows them all\)\n\S+ --- the page loads \S+\n#\d+ /);
    assert.doesNotMatch(await ok('requests 4 cut='), /last \d+ of/, 'nothing said when all are shown');
    assert.match(listed, /^#\d+ \S+ GET \S+ \S+ fetch http\S+cut=\d$/m, 'with its kind');
    // Chrome reports a response with no body as aborted once it has come.
    await ok('eval fetch("/api/empty").then(r => r.status)');
    await waitFor(async () => /GET 204 \d+ms fetch \S+\/api\/empty$/.test(await ok('requests 1 /api/empty')), 'the 204 to show as answered');
    await ok('reload');
    await ok('eval fetch("/api/data?cut=after").then(r => r.status)');
    await waitFor(async () => /cut=after/.test(listed = await ok('requests 3 cut=')), 'the request after the reload');
    assert.match(listed, /cut=3\n\S+ --- the page loads http:\/\/\S+\/\n#\d+ .*cut=after$/, 'where the load starts, though the filter hides its request');
    await ok('eval ["a", "b", "c"].forEach(t => console.log("cut-" + t))');
    assert.match(await ok('console 1 cut-'), /^\(last 1 of 3 kept; console 3 cut- shows them all\)\n[\s\S]*cut-c$/);
  });

  it('says when the request log has dropped older ones', async () => {
    await ok('tab new about:blank');
    try {
      await ok(`goto ${site.url}/other`);
      await ok('eval Promise.all(Array.from({ length: 205 }, (_, i) => fetch("/api/data?full=" + i)))');
      assert.match(await ok('requests 1'), /^\(last 1 of 200 kept; requests 200 shows them all; older requests are no longer kept\)\n/);
      assert.match(await ok('requests 200 full=1'), /^\(older requests are no longer kept: only the last 200 of every kind are\)\n/);
    } finally {
      await ok('tab close');
    }
  });

  it('waits for a request still under way, patches an array, and says why a reload did not load', async () => {
    await ok(`tab new ${site.url}/`);
    try {
      await ok('eval fetch("/api/slow"); 0');
      await ok('info');
      assert.match(await ok('wait request /api/slow 5'), /GET 200 \S+\/api\/slow$/, 'begun two commands ago, finished during the wait');
      await ok('route **/api/data patch [1, 2]');
      assert.match(await ok('eval fetch("/api/data").then(r => r.json()).then(j => JSON.stringify(j))'), /^Patched: #\d+ GET \S+ -> 200\n\[1,2\]$/, 'an array replaces the body');
      await ok('route off --all');
      await ok('eval document.body.insertAdjacentHTML("beforeend", "<p>4242</p>"); 0');
      assert.equal(await ok('wait text 4242'), 'Visible: 4242', 'a number that is all there is to wait for');
      await ok('network off');
      const reloaded = await repl.run('reload');
      assert.match(reloaded.output, /^Error: The page did not load: #\d+ \S+ failed: net::ERR_INTERNET_DISCONNECTED$/);
      assert.match(await ok('info'), /^  Error: Chrome's error page, for #\d+ http:\/\/\S+ failed: net::ERR_INTERNET_DISCONNECTED$/m);
      await ok('network on');
    } finally {
      await ok('modes off --mine');
      await ok('tab close');
    }
  });

  it('keeps requests, marks fakes, and hides static files by default', async () => {
    await ok('route **/api/data 500 {}');
    await ok(fetchStatus);
    await ok('route off --all');
    // The browser reports completion shortly after fetch() resolves.
    let recent = '';
    await waitFor(async () => /GET 500 faked \d+ms .*\/api\/data/.test(recent = await ok('requests 50')), 'the faked request to settle');
    assert.doesNotMatch(recent, /style\.css/);
    assert.match(await ok('requests --all 50'), /style\.css/);
    assert.match(await ok('requests 50 nothing-matches-this'), /No requests matching/);
    assert.match(await ok('requests 50 --regex /api/d.ta$'), /\/api\/data$/);
    assert.match(await ok('requests 50 --regex ^nothing'), /No requests matching \/\^nothing\//);
    assert.match(await ok('requests --filter=d.ta$'), /^\(playwright-cli's requests --filter is requests --regex <pattern> here\)\n(?:\(last 20 of \d+ kept; requests \d+ --regex d\.ta\$ shows them all\)\n)?(?:\S+ --- the page loads \S+\n)?#\d+ /);
    assert.match(await ok('requests --static'), /style\.css/, 'playwright-cli\'s --static is --all');
    assert.match(await ok('requests 50 --regex "/api/d\\w+$"'), /\/api\/data$/, 'double-quoted, its backslashes kept');
    assert.match(await ok('requests --filter "/api/d\\w+$"'), /\/api\/data$/);
    const { spawnSync } = require('child_process');
    const bin = require('path').join(__dirname, '..', 'bin', 'pw-repl.js');
    const sent = spawnSync(process.execPath, [bin, 'send', '-e', repl.socket, 'requests', '--filter=/api/d\\w+ ?$'], { encoding: 'utf8' });
    assert.match(sent.stdout, /\/api\/data$/m, 'through send, a value with a space and a backslash');
    assert.match(await ok('requests 50'), /\(\d+ hidden between these: images, fonts, stylesheets, media and extension requests; requests --all shows them\)$/);
  });

  it('shows the body of a request, real or faked', async () => {
    await ok(fetchStatus);
    await ok('route **/api/data 418 {"fake":1}');
    await ok(fetchStatus);
    await ok('route off --all');
    let recent = '';
    await waitFor(async () => /GET 418 faked/.test(recent = await ok('requests 50 /api/data')) && /GET 200 \d+ms fetch/.test(recent), 'the requests to settle');
    // The latest one: bodies from before an earlier navigation may be gone.
    const real = [...recent.matchAll(/#(\d+) \S+ GET 200 \d+ms fetch \S+\/api\/data/g)].pop()[1];
    const faked = /#(\d+) \S+ GET 418 faked/.exec(recent)[1];
    assert.match(await ok(`body ${real}`), /"real": true/);
    assert.match(await ok(`body #${faked}`), /"fake": 1/);
    const missing = await repl.run('body 99999');
    assert.equal(missing.status, 'error');
    assert.match(missing.output, /No request #99999/);
    assert.match(await ok('body /api/data'), /GET 418 faked[\s\S]*"fake": 1/, 'the latest whose URL contains it');
    assert.match((await repl.run('body /never-requested')).output, /No finished request on the selected tab has a URL containing \/never-requested/);
  });

  it('shows a body with no content type as text when it is text', async () => {
    await ok('eval Promise.all([fetch("/untyped-text"), fetch("/untyped-bytes")]).then(() => "fetched")');
    await waitFor(async () => { const recent = await ok('requests 50 /untyped'); return /GET 404 .*\/untyped-text/.test(recent) && /GET 200 .*\/untyped-bytes/.test(recent); }, 'the requests to settle');
    assert.match(await ok('body /untyped-text'), /404 \S+\/untyped-text \(no content type, 9 bytes\)\nnot found$/);
    assert.match(await ok('body /untyped-bytes'), /\(no content type, 6 bytes\)\n\[binary body not shown\]$/);
  });

  it('keeps console messages and uncaught errors without a capture', async () => {
    await ok('click #noisy');
    let logs = '';
    await waitFor(async () => /\[pageerror\].*boom-uncaught/.test(logs = await ok('console 50')), 'the page error');
    assert.match(logs, /\[log\] hello-log/);
    assert.match(logs, /\[error\] bad-thing/);
    await ok('eval console.log("y".repeat(10000))');
    await waitFor(async () => /y{4000}…/.test(await ok('console --all 5')), 'the long message');
    assert.equal(await ok('console 5 --all'), await ok('console --all 5'), '--all at the end too');
    assert.equal(await ok('console error --all'), await ok('console --all error'));
    assert.doesNotMatch(await ok('console --all 5'), /y{4001}/, 'long messages are clipped when stored');
    const errors = await ok('console 50 error');
    assert.doesNotMatch(errors, /hello-log/);
    assert.match(errors, /bad-thing/);
    assert.match(errors, /boom-uncaught/, 'a page error is an error');
    await ok('eval console.warn("careful-warn"); console.debug("quiet-debug"); 0');
    await waitFor(async () => /quiet-debug/.test(await ok('console 50 debug')), 'the debug message');
    const warnings = await ok('console 50 warning');
    assert.match(warnings, /\[warning\] careful-warn/);
    assert.match(warnings, /\[error\] bad-thing/, 'warning includes errors, as playwright-cli\'s does');
    assert.doesNotMatch(warnings, /hello-log/);
    const info = await ok('console 50 info');
    assert.match(info, /hello-log/);
    assert.doesNotMatch(info, /quiet-debug/, 'info leaves out debug');
    assert.match(await ok('console 50 careful'), /careful-warn/, 'anything else is a filter');
    await ok('reload');
    await ok('eval console.log("after-reload"); 0');
    await waitFor(async () => /after-reload/.test(await ok('console 3')), 'the message after the reload');
    assert.match(await ok('console 3'), /--- the page loaded \S+\n[\s\S]*\[log\] after-reload$/, 'a load between messages is marked');
    await ok('eval Promise.all(Array.from({ length: 250 }, (_, i) => fetch("/api/data?" + i))).then(() => "fetched")');
    await ok('reload');
    await ok('eval console.log("after-many"); 0');
    await waitFor(async () => /after-many/.test(await ok('console 50')), 'the message after many requests');
    assert.match(await ok('console 50'), /after-reload[\s\S]*--- the page loaded \S+\n[\s\S]*after-many$/, 'still marked after more requests than the request log keeps');
    await ok('eval history.pushState({}, "", "#cart"); console.log("after-route"); 0');
    await waitFor(async () => /after-route/.test(await ok('console 2')), 'the message after the route change');
    assert.doesNotMatch(await ok('console 2'), /after-many[\s\S]*--- the page loaded[\s\S]*after-route/, 'an app\'s own route change loads nothing');
    assert.match(await ok('console 1'), /^(?:\(last 1 of \d+ kept; console \d+ shows them all\)\n)?\S+ --- the page loaded \S+\n\S+ \[log\] after-route$/, 'from the load the first message came from');
    await ok('eval history.replaceState({}, "", location.pathname); 0');
  });

  it('captures requests and console messages together until capture off', async () => {
    assert.match(await ok('capture'), /Not capturing\.[\s\S]*capture on \[requests\|console\]/);
    await ok('capture on');
    assert.match(await ok('capture on'), /Already capturing/);
    await ok(fetchStatus);
    await ok('click #noisy');
    await new Promise(r => setTimeout(r, 300));
    assert.match(await ok('capture'), /Capturing requests and console on \S+ since [\s\S]*capture off/);
    const captured = await ok('capture off');
    assert.match(captured, /^\+\d+\.\d{3}s #\d+ GET 200 \S+\/api\/data$/m);
    assert.match(captured, /^\+\d+\.\d{3}s \[log\] hello-log$/m);
    assert.match(captured, /^\+\d+\.\d{3}s \[pageerror\] Error: boom-uncaught/m);
    assert.match(await ok('capture'), /Not capturing\. The last capture, of requests and console[\s\S]*hello-log/);
    assert.match(await ok('capture off'), /Not capturing/);
  });

  it('captures one kind for a set time', async () => {
    await ok('eval setTimeout(() => { fetch("/api/data"); console.log("timed-log"); }, 200); "scheduled"');
    const captured = await ok('capture on requests 1');
    assert.match(captured, /Capturing requests for 1s/);
    assert.match(captured, /\/api\/data/);
    assert.doesNotMatch(captured, /timed-log/);
    assert.match(await ok('capture'), /Not capturing/, 'a timed capture stops by itself');
    assert.equal((await repl.run('capture on 0')).status, 'error');
    assert.equal((await repl.run('capture on requests console')).status, 'error');
  });

  it('cuts and restores the network', async () => {
    assert.match(await ok('network'), /network is on\.\n\n +network off/);
    await ok('network off');
    assert.match(await ok('network'), /network is off \(offline\)\.\n\n +network on/);
    assert.match(await ok(fetchStatus), /Failed to fetch/);
    await ok('network on');
    assert.equal(await ok(fetchStatus), '200');
    assert.equal((await repl.run('network offline')).status, 'error');
  });

  it('slows the network, and restores it', async () => {
    const timed = 'eval (async () => { const t = performance.now(); await fetch("/api/data?" + Math.random()); return Math.round(performance.now() - t); })()';
    assert.match(await ok('network'), /network slow \[<ms> \[<kbps>\]\] +slow it \(default 563ms latency/);
    assert.match(await ok('network slow 700'), /network is slow \(700ms latency, 1440 kbps down, 675 kbps up\)/);
    assert.ok(Number(await ok(timed)) >= 650, 'a request takes the latency');
    assert.match(await ok('modes'), /\(network:slow\)$/m);
    assert.match(await ok('network'), /is slow \(700ms latency[\s\S]*network on +restore it/);
    await ok('network slow');
    assert.match(await ok('network'), /is slow \(563ms latency, 1440 kbps down, 675 kbps up\)/);
    await ok('network on');
    assert.ok(Number(await ok(timed)) < 500, 'back to full speed');
    for (const bad of ['network slow fast', 'network slow 99999', 'network slow 100 0', 'network slow 1 2 3']) {
      assert.equal((await repl.run(bad)).status, 'error', bad);
    }
  });

  it('cuts the network per tab', async () => {
    await ok('network off');
    await ok(`tab new ${site.url}/`);
    assert.equal(await ok(fetchStatus), '200', 'a new tab is not offline');
    await ok('network off');
    assert.match(await ok(fetchStatus), /Failed to fetch/, 'network off applies to the selected tab');
    await ok('network on');
    assert.equal(await ok(fetchStatus), '200');
    await ok('tab close');
    await ok('tab 1');
    assert.match(await ok(fetchStatus), /Failed to fetch/, 'the first tab is still offline');
    await ok('network on');
    assert.equal(await ok(fetchStatus), '200');
  });

  it('lists the modes on in every tab, and turns them all off', async () => {
    assert.match(await ok('modes'), /^No modes are on in any tab\.\n\n +watch on /);
    assert.match(await ok('modes off'), /No modes were on/);
    await ok('watch on');
    await ok('network off');
    await ok(`tab new ${site.url}/?modes`);
    await ok('route **/api/a 500 {}');
    await ok('route **/api/b 500 {}');
    await ok('capture on');
    const listing = await ok('modes');
    assert.match(listing, /^  \[1\] \S+\/ +\(watch network:off\)$/m);
    assert.match(listing, /^\* \[\d\] \S+\?modes +\(routes:2 capture\)$/m);
    assert.match(listing, /\)\n\n +modes off +turn them all off$/);
    const off = await ok('modes off');
    assert.match(off, /\S+\/: watch off, network on$/m);
    assert.match(off, /\?modes: capture off \(capture shows it\), 2 routes removed$/m);
    assert.match(await ok('modes'), /No modes are on/);
    assert.equal(await ok(fetchStatus), '200');
    await ok('tab close');
    await ok('tab 1');
    assert.equal(await ok(fetchStatus), '200', 'the other tab is back online');
  });

  it('ends a capture when its tab closes, and reads or stops one with no tab selected', async () => {
    await ok('tab');
    await ok('tab 0');
    await ok(`tab new ${site.url}/?captured`);
    await ok('capture on');
    const closed = await ok('tab close');
    assert.match(closed, /The captured tab closed, which ended the capture/);
    assert.match(closed, /no tab is selected now/);
    assert.match(await ok('modes'), /^No modes are on in any tab\./, 'the capture is not left on');
    assert.match(await ok('capture'), /^Not capturing\. The last capture/);
    assert.match(await ok('capture off'), /Not capturing/);
    const refused = await repl.run('capture on');
    assert.equal(refused.status, 'error');
    assert.match(refused.output, /No tab is selected/);
    await ok('tab');
    await ok('tab 1');
  });

  it('answers a dialog with dialog, ahead of the commands waiting on it', async () => {
    assert.equal(await ok('dialog'), 'No dialog is open.');
    const start = repl.stdout.length;
    const click = repl.run('click #alerter');
    await waitFor(() => /Dialog \[confirm\]: sure\?/.test(repl.stdout.slice(start)), 'the dialog');
    const waiting = repl.run('text #out');
    assert.match(await ok('dialog'), /^\[\d+\] \S+: confirm "sure\?"\n\n +dialog accept \[text\]/);
    assert.match(await ok('dialog accept'), /^Accepted: \[\d+\] \S+: confirm "sure\?"$/);
    assert.equal((await click).status, 'ok');
    const read = await waiting;
    assert.equal(read.status, 'ok');
    assert.equal(read.output, 'answered true', 'the command queued behind the dialog ran once it was answered');
    assert.equal(await ok('dialog'), 'No dialog is open.');
    assert.equal((await repl.run('dialog dismiss')).status, 'error');
  });

  it('answers a dialog with playwright-cli\'s dialog-accept and dialog-dismiss, ahead of the queue too', async () => {
    for (const [command, answer] of [['dialog-accept', 'true'], ['dialog-dismiss', 'false']]) {
      const start = repl.stdout.length;
      const click = repl.run('click #alerter');
      await waitFor(() => /Dialog \[confirm\]: sure\?/.test(repl.stdout.slice(start)), 'the dialog');
      assert.match(await ok(command), /Accepted|Dismissed/);
      assert.equal((await click).status, 'ok');
      assert.equal(await ok('text #out'), `answered ${answer}`);
    }
  });

  it('reports a read-only timeout as an error and carries on', async () => {
    const result = await repl.run('text #not-on-the-page');
    assert.equal(result.status, 'error');
    assert.match(result.output, /No element matches #not-on-the-page \(waited 5s\)/);
    assert.doesNotMatch(result.output, /disconnecting/);
    assert.match(await ok('info'), /Title: Fixture$/m);
  });

  it('reports unknown commands as errors', async () => {
    const result = await repl.run('nosuch');
    assert.equal(result.status, 'error');
    assert.match(result.output, /Unknown command: nosuch/);
  });

  it('prints completion markers for tagged prompt commands only', async () => {
    const id = `t${Date.now()}`;
    repl.type(`@${id} info`);
    await waitFor(() => repl.stdout.includes(`[[pw-done:${id}:ok]]`), 'the completion marker');
    repl.type(`@${id}x nosuch`);
    await waitFor(() => repl.stdout.includes(`[[pw-done:${id}x:error]]`), 'the error marker');
    const start = repl.stdout.length;
    repl.type('info');
    await waitFor(() => /Title: Fixture/.test(repl.stdout.slice(start)), 'the untagged command');
    await new Promise(r => setTimeout(r, 200));
    assert.doesNotMatch(repl.stdout.slice(start), /pw-done/, 'an untagged command prints no marker');
  });

  it('shows the server is on in the prompt', () => {
    assert.match(repl.stdout, /pw\[serve\]> /);
  });

  it('shows the modes on in the selected tab before the prompt', async () => {
    const endsWith = async (prompt, what) => {
      const start = repl.stdout.length;
      await ok('info');
      await waitFor(() => repl.stdout.slice(start).endsWith(`\n${prompt}`), what);
    };
    await ok('watch on');
    await ok('network off');
    await ok('route **/api/x 500 {}');
    await endsWith('(watch network:off routes:1) pw[serve]> ', 'the modes before the prompt');
    await ok(`tab new ${site.url}/`);
    await endsWith('pw[serve]> ', 'no modes in a new tab');
    await ok('tab close');
    await ok('tab 1');
    await endsWith('(watch network:off routes:1) pw[serve]> ', 'the modes again');
    await ok('modes off');
    await endsWith('pw[serve]> ', 'no modes once they are off');
  });

  it('echoes server commands to the pane', async () => {
    await ok('info');
    assert.match(repl.stdout, /\[server\] info/);
  });

  describe('server safety', () => {
    it('creates an owner-only socket', () => {
      assert.equal(fs.statSync(repl.socket).mode & 0o777, 0o600);
    });

    it('refuses requests from web pages', async () => {
      const result = await repl.request('{"command":"info"}', { 'Content-Type': 'application/json', Origin: 'https://example.com' });
      assert.equal(result.code, 403);
    });

    it('refuses bodies that are not JSON', async () => {
      assert.equal((await repl.request('{"command":"info"}', { 'Content-Type': 'text/plain' })).code, 415);
      assert.equal((await repl.request('nope')).code, 400);
      assert.equal((await repl.run('info\ninfo')).code, 400);
    });

    it('keeps quit at the prompt', async () => {
      const result = await repl.run('quit');
      assert.equal(result.status, 'error');
      assert.equal(repl.exited, false);
    });
  });
});

describe('a command that times out', { skip: SKIP }, () => {
  let chrome, site, repl;

  before(async () => {
    chrome = await startChrome();
    site = await startSite();
    repl = await startRepl(chrome.cdpUrl);
    await repl.run(`tab new ${site.url}/`);
  });

  after(async () => {
    await repl?.stop();
    site?.stop();
    await chrome?.stop();
  });

  it('reports an element that never appeared as an ordinary error, and carries on', async () => {
    const result = await repl.run('click #not-on-the-page');
    assert.equal(result.status, 'error');
    assert.equal(result.unconfirmed, undefined, 'nothing was clicked');
    assert.match(result.output, /^Error: No element matches #not-on-the-page \(waited 5s\)$/m);
    assert.doesNotMatch(result.output, /Outcome unknown/);
    assert.equal((await repl.run('info')).status, 'ok');
  });

  it('reports a click that timed out after finding its element as unconfirmed, in a line, and carries on', async () => {
    // Through send, for its exit status too.
    const { spawn } = require('child_process');
    const sent = await new Promise(resolve => {
      const child = spawn(process.execPath, [require('path').join(__dirname, '..', 'bin', 'pw-repl.js'), 'send', '-e', repl.socket, 'click', '#under'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', status => resolve({ status, stdout, stderr }));
    });
    assert.equal(sent.status, 2, 'completion not confirmed');
    assert.match(sent.stderr, /completion not confirmed/);
    assert.doesNotMatch(sent.stdout, /snapshot ref/);
    assert.match(sent.stdout, /^Error: Timed out after 5s on #under: <span.*> intercepts pointer events \(its call log is in the REPL's pane or log\)\nOutcome unknown: it timed out after it began acting on the page/);
    assert.doesNotMatch(sent.stdout, /Call log/);
    assert.match(repl.stdout, /Playwright's call log:[\s\S]*attempting click action/, 'the whole log is in the pane');
    assert.equal(repl.exited, false);
    assert.equal((await repl.run('info')).status, 'ok');
  });
});

describe('watch on --changes on a page too busy to snapshot', { skip: SKIP }, () => {
  let chrome, site, repl;

  before(async () => {
    chrome = await startChrome();
    site = await startSite();
    repl = await startRepl(chrome.cdpUrl);
    await repl.run(`tab new ${site.url}/`);
  });

  after(async () => {
    await repl?.stop();
    site?.stop();
    await chrome?.stop();
  });

  it('starts watching anyway instead of disconnecting', async () => {
    // Keeps the page busy for 4s right after watch on sets up, so the first snapshot times out.
    await repl.run('eval Object.defineProperty(window, "__pwReplWatching", { get: () => false, set() { setTimeout(() => { const t = Date.now(); while (Date.now() - t < 4000); }); } })');
    const result = await repl.run('watch on --changes');
    assert.equal(result.status, 'ok', result.output);
    assert.match(result.output, /Could not snapshot the page yet/);
    assert.equal(repl.exited, false);
    assert.equal((await repl.run('info')).status, 'ok');
  });
});

describe('quitting at the prompt while a sent command runs', { skip: SKIP }, () => {
  const { spawn } = require('child_process');
  const path = require('path');
  let chrome, site, repl;

  before(async () => {
    chrome = await startChrome();
    site = await startSite();
  });

  after(async () => {
    await repl?.stop();
    site?.stop();
    await chrome?.stop();
  });

  // Sends through pw-repl send, as an agent would, and stops the REPL once the command is running.
  const sendThenQuit = async (command, stop = () => repl.type('quit')) => {
    // Each test starts its own REPL; the one before is stopped so its socket folder goes too.
    await repl?.stop();
    repl = await startRepl(chrome.cdpUrl);
    await repl.run(`tab new ${site.url}/`);
    const sender = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'pw-repl.js'), 'send', '-e', repl.socket, '-t', '30', command]);
    let stdout = '';
    let stderr = '';
    sender.stdout.on('data', d => { stdout += d; });
    sender.stderr.on('data', d => { stderr += d; });
    await waitFor(() => repl.stdout.includes(`[server] ${command}`), 'the command to start');
    await new Promise(r => setTimeout(r, 300));
    stop();
    const code = await new Promise(resolve => sender.on('exit', resolve));
    await waitFor(() => repl.exited, 'the REPL to exit');
    return { code, stdout, stderr };
  };

  it('answers a command that changes the page as not confirmed', async () => {
    const result = await sendThenQuit('click #not-on-the-page');
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stdout, /quit before this command finished; its outcome is unknown/);
    assert.match(result.stderr, /completion not confirmed/);
    assert.doesNotMatch(result.stdout, /Disconnecting/, "the quit's own output is not the sender's");
  });

  it('answers it the same way when the REPL is stopped by a signal', async () => {
    const result = await sendThenQuit('click #not-on-the-page', () => repl.proc.kill('SIGTERM'));
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stdout, /its outcome is unknown/);
  });

  it('answers a read-only command that the browser would never end as interrupted', async () => {
    const result = await sendThenQuit('wait request /never 30');
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /The REPL quit before this command finished\.$/m);
    assert.doesNotMatch(result.stderr, /cannot reach|not answering/);
  });
});

describe('closing the terminal of a serving REPL', { skip: SKIP }, () => {
  let chrome, repl;

  before(async () => {
    chrome = await startChrome();
    repl = await startRepl(chrome.cdpUrl);
  });

  after(async () => {
    await repl?.stop();
    await chrome?.stop();
  });

  it('removes the socket on SIGHUP', async () => {
    assert.ok(fs.existsSync(repl.socket));
    repl.proc.kill('SIGHUP');
    await waitFor(() => repl.exited, 'the REPL to exit');
    assert.equal(fs.existsSync(repl.socket), false);
  });
});
