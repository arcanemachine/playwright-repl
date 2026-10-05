const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { SKIP, waitFor, startChrome, startSite, startRepl } = require('./harness');

// The ffmpeg record would use, if any: its tests are skipped without one, as the browser's are without Chromium.
const FFMPEG = (() => { try { return require('../lib/record').findFfmpeg('webm'); } catch { return null; } })();

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
    while (/^[* ]*\[\d+\]/.test((await repl.run('dialog')).output)) await repl.run('dialog dismiss');
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
  // send --file in a process of its own, not spawnSync: the test site is served from this process, and a
  // file's goto needs it.
  const pwSend = (args, env = {}) => new Promise(resolve => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [require('path').join(__dirname, '..', 'bin', 'pw-repl.js'), 'send', '-e', repl.socket, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    child.on('close', status => resolve({ status, output }));
  });
  const sendFile = (name, env = {}, flags = []) => pwSend(['--file', name, ...flags], env);

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
      assert.equal(await ok('click text=Far'), 'Clicked: text=Far (the first of 2 matches: <button> Far)', 'the first in page order, out of view or not, named');
      assert.equal(await ok(log), 'free free far-first ');
      await ok('eval scrollTo(0, 0)');
      for (let i = 0; i < 5; i += 1) {
        await ok('eval redraw()');
        assert.match(await ok('click text=Again'), /^Clicked: text=Again \(match 2 of 2;/, 'chosen again when rendered again');
      }
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

  it('keeps a tab in the background drawing after input, so clicks there are not delayed', async () => {
    await ok(`tab new ${site.url}/?background-clicks`);
    for (let i = 0; i < 5; i++) await ok('click #go');
    // Chrome all but stops drawing a background tab after input (about a frame a second), and a click
    // waits for frames: 1-2s each without the screencast. Frames are counted, not clicks timed, so a busy
    // machine does not fail it.
    const frames = await ok('eval new Promise(r => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); })');
    assert.ok(Number(frames) >= 20, `${frames} frames in a second`);
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
    assert.equal(await ok('eval "document.title"'), 'document.title\n(That is a string: the JavaScript was in quotes, which eval keeps. Without them, it runs: eval document.title)', 'quotes around all of it, said');
    assert.equal(await ok('eval `${document.title}-x`'), 'Fixture-x', 'a template that ran is no string as typed');
    assert.equal(await ok('eval "a" + document.title + "b"'), 'aFixtureb', 'nor strings joined');
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

  it('types into a date or time input as the user would, and says what it holds, or how fill sets it', async () => {
    await ok('eval document.body.insertAdjacentHTML("beforeend", "<input type=date id=when><input type=time id=at>"); 0');
    const iso = await repl.run('type #when 2026-10-02');
    assert.equal(iso.status, 'error', iso.output);
    assert.match(iso.output, /^Error: #when is a date input: typed, 2026-10-02 comes out mangled, .* fill #when 2026-10-02 sets it$/);
    assert.equal(await ok('eval document.querySelector("#when").value'), '""', 'nothing was typed');
    assert.equal(await ok('type #at 0230P'), 'Typed into: #at, a time input, which now holds 14:30');
    await ok('fill #at ""');
    await ok('click #at');
    assert.match((await repl.run('type 9')).output, /The focused input#at, a time input, is still empty: .* fill <selector> 14:30$/);
    await ok('fill #when 2026-10-02');
    assert.equal(await ok('eval document.querySelector("#when").value'), '2026-10-02');
    // Inside a shadow root, as a component library wraps one: its value is read from the input, not the host.
    await ok('eval const host = document.createElement("x-d"); host.attachShadow({ mode: "open" }).innerHTML = "<input type=time id=inner>"; document.body.append(host); 0');
    assert.equal(await ok('type #inner 0230P'), 'Typed into: #inner, a time input, which now holds 14:30');
    assert.equal(await ok('type #inner 0315P'), 'Typed into: #inner, a time input, which now holds 15:15', 'from its first part again');
    assert.match((await repl.run('type 14:30')).output, /^Error: The focused input#inner is a time input: .* fill <selector> 14:30 sets it$/);
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

  it('leaves a password field\'s value out of snapshot, html and attrs, and no other field\'s', async () => {
    await ok('fill #pw hunter2');
    await ok('fill #name Ada');
    await ok('eval document.body.insertAdjacentHTML("beforeend", "<input id=otp aria-label=Code autocomplete=one-time-code><input id=cvc type=number aria-label=CVC autocomplete=cc-csc>"); 0');
    await ok('fill #otp 424242');
    await ok('fill #cvc 987');
    const snap = await ok('snapshot');
    assert.match(snap, /textbox "Password" \[ref=(e\d+)\]: \(a password: not shown\)/);
    assert.match(snap, /textbox "Code"[^\n]*: \(a password: not shown\)/, 'nor a one-time code');
    assert.match(snap, /spinbutton "CVC"[^\n]*: \(a password: not shown\)/, 'nor a card\'s code, a number field');
    assert.match(snap, /textbox "Name"[^\n]*: Ada/);
    const ref = /textbox "Password" \[ref=(e\d+)\]/.exec(snap)[1];
    for (const view of ['snapshot --full', `snapshot ${ref}`, 'snapshot #pw', 'snapshot --grep Password']) {
      const shown = await ok(view);
      assert.match(shown, /\(a password: not shown\)/, view);
      assert.doesNotMatch(shown, /hunter2|424242|987/, view);
    }
    // As a page that keeps the value attribute in step with the field does (React).
    await ok('eval pw.setAttribute("value", pw.value); document.querySelector("#name").setAttribute("value", "Ada"); 0');
    assert.match(await ok('attrs #pw'), /"value": "\(a password: not shown\)"/);
    assert.match(await ok('attrs #name'), /"value": "Ada"/);
    const html = await ok('html body');
    assert.match(html, /<input id="pw" type="password" aria-label="Password" value="\(a password: not shown\)">/);
    assert.match(html, /value="Ada"/);
    assert.doesNotMatch(html, /hunter2/);
    // Copied where the page's code does not run: no custom element is made again.
    await ok('eval customElements.define("x-made", class extends HTMLElement { constructor() { super(); window.made = (window.made || 0) + 1; } }); document.body.append(document.createElement("x-made")); 0');
    await ok('html body');
    assert.equal(await ok('eval window.made'), '1');
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

  it('marks the tab in front, as the user\'s tabs say, and never one a client uses', async () => {
    const { chromium } = require('playwright-core');
    // The user, at the browser: a connection that tells no tab it is in front, as pw-repl's own does not.
    const user = await chromium.connectOverCDP(chrome.cdpUrl, { noDefaults: true });
    try {
      const a = await user.contexts()[0].newPage();
      await a.goto(`${site.url}/?user-a`);
      const b = await user.contexts()[0].newPage();
      await b.goto(`${site.url}/?user-b`);
      const marked = async () => (await ok('tab')).split('\n').filter(l => /\(visible/.test(l)).map(l => (/\?user-[\w-]+/.exec(l) || [l.trim()])[0]);
      await a.bringToFront();
      assert.deepEqual(await marked(), ['?user-a']);
      await b.bringToFront();
      assert.deepEqual(await marked(), ['?user-b'], 'it follows the tab the browser shows');
      // An incognito window, opened as the user would (not through Playwright, which would tell its tabs
      // they are in front): its front tab is marked as well, and the one behind it is not.
      const browser = await user.newBrowserCDPSession();
      try {
        const { browserContextId } = await browser.send('Target.createBrowserContext');
        await browser.send('Target.createTarget', { url: `${site.url}/?user-incognito-back`, browserContextId });
        await browser.send('Target.createTarget', { url: `${site.url}/?user-incognito-front`, browserContextId });
        await waitFor(async () => (await marked()).includes('?user-incognito-front'), 'the incognito window\'s front tab');
        assert.deepEqual((await marked()).sort(), ['?user-b', '?user-incognito-front'], 'one in front in each window');
        await browser.send('Target.disposeBrowserContext', { browserContextId });
      } finally {
        await browser.detach();
      }
      // A tab a client uses is told it is in front, so that clicks in it work behind another: it is not asked.
      await ok('tab ?user-a');
      await ok('click #go');
      await b.bringToFront();
      await ok('click #go');
      assert.deepEqual(await marked(), ['?user-b']);
      await ok('tab ?user-b');
      assert.deepEqual(await marked(), [], 'selected, it is not asked');
    } finally {
      await user.close();
      await ok('tab 1');
    }
  });

  it('saves what was watched as commands that send --file runs again, values and all, a password as a variable', async () => {
    const path = require('path');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-repl-flow-'));
    const file = path.join(dir, 'flow.txt');
    try {
      await ok(`goto ${site.url}/flow`);
      assert.match(await ok('watch on'), /What is typed is recorded, except in password fields; --no-values leaves it out\./);
      await ok('click ".row:nth-of-type(2) button"');
      await ok('click ".row:nth-of-type(1) button"');
      await ok('fill [name=who] "-Ada  "');
      await ok('press [name=who] Enter');
      await ok('select #area Shipping');
      await ok('check #gift');
      await ok('fill #pw hunter2');
      await ok('click #show');
      await ok('fill #pw hunter3');
      await ok('fill #otp 424242');
      await ok('fill "x-card:nth-of-type(2) #qty" 3');
      await ok('select #plan pro-yearly');
      await ok('click "x-pair .target"');
      await ok('eval note.value = "two\\nlines"; note.dispatchEvent(new Event("change", { bubbles: true })); 0');
      await ok('click #route');
      await ok('click #next');
      await ok('wait load');
      await waitFor(async () => /navigate \S+\/other/.test(await ok('watch')), 'the last step');
      const steps = await ok('watch');
      assert.match(steps, /type textbox "Name" "-Ada  "/, 'what was typed, shown');
      assert.match(steps, /type textbox "Password" \(a password: not recorded\)/);
      assert.doesNotMatch(steps, /hunter|424242/, 'no secret, even once shown as text');
      assert.match(await ok(`watch save ${file}`), /^Saved \d+ steps to \S+flow\.txt; 2 could not be written as commands[\s\S]*\{\{ PW_PASSWORD \}\}, \{\{ PW_CODE \}\}\.\nPW_PASSWORD=\.\.\. PW_CODE=\.\.\. pw-repl send --file/);
      const saved = fs.readFileSync(file, 'utf8');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only the user reads what they typed');
      assert.doesNotMatch(saved, /hunter|424242/);
      const commands = saved.split('\n').filter(l => l && !l.startsWith('#'));
      assert.deepEqual(commands, [
        `goto ${site.url}/flow`,
        "click 'body > div:nth-of-type(2) > button'",
        "click 'body > div:nth-of-type(1) > button'",
        `fill 'role=textbox[name*="Name"]' "-Ada  "`,
        `press 'role=textbox[name*="Name"]' Enter`,
        `select 'role=combobox[name*="Area"]' "Shipping"`,
        `check 'role=checkbox[name*="Gift"]'`,
        `fill 'role=textbox[name*="Password"]' "{{ PW_PASSWORD }}"`,
        `click 'role=button[name*="Show"]'`,
        `fill 'role=textbox[name*="Password"]' "{{ PW_PASSWORD }}"`,
        `fill 'role=textbox[name*="Code"]' "{{ PW_CODE }}"`,
        `fill 'body > x-card:nth-of-type(2) #qty' "3"`,
        `select 'role=combobox[name*="Plan"]' "pro-yearly"`,
        `click 'role=button[name*="Route"]'`,
        `wait 'role=link[name*="Next"]' 30`,
        `click 'role=link[name*="Next"]'`,
        'wait load',
      ]);
      assert.match(saved, /^# PW_PASSWORD=\.\.\. PW_CODE=\.\.\. pw-repl send --file flow\.txt runs it/m);
      assert.match(saved, /^# It needs PW_PASSWORD, PW_CODE set in the environment: what was typed into password fields/m, 'a one-time code is one too');
      assert.match(saved, /^# fill textbox "Note": what was typed has a line break/m);
      assert.match(saved, /^# select combobox "Plan" "Pro, billed yearly, [^"]*"\n/m, 'the label, for the reader');
      assert.match(saved, /^# click i "\+": no selector finds it alone/m, 'its place in its shadow root matches one in the host\'s children too');
      assert.match(saved, /^# the app went to \S+\/flow\/routed without loading a page$/m);
      assert.match((await repl.run(`watch save ${file}`)).output, /exists already/);
      // Run again on a fresh page, it ends where the watched steps did, the cart and form as they were.
      await ok(`goto ${site.url}/flow`);
      const lines = saved.split('\n');
      const beforeLeaving = path.join(dir, 'stay.txt');
      fs.writeFileSync(beforeLeaving, lines.slice(0, lines.findIndex(l => l === `wait 'role=link[name*="Next"]' 30`)).join('\n'));
      const unset = await sendFile(beforeLeaving);
      assert.equal(unset.status, 1);
      assert.match(unset.output, /stopped at line \d+ of \S+stay\.txt \(fill 'role=textbox\[name\*="Password"\]' "\{\{ PW_PASSWORD \}\}"\): PW_PASSWORD is not set/);
      await ok(`goto ${site.url}/flow`);
      // Escaped as double quotes read it, and shown nowhere: the REPL shows the line as written.
      const secret = 'pa"ss\\word 9';
      const shown = repl.stdout.length;
      const run = await sendFile(beforeLeaving, { PW_PASSWORD: secret, PW_CODE: '555111' });
      assert.equal(run.status, 0, run.output);
      assert.match(repl.stdout.slice(shown), /fill 'role=textbox\[name\*="Password"\]' "\{\{ PW_PASSWORD \}\}"/);
      assert.doesNotMatch(repl.stdout.slice(shown) + run.output, /pa"ss|555111/);
      assert.equal(await ok('eval JSON.stringify([pw.value, otp.value])'), JSON.stringify([secret, '555111']));
      const literal = path.join(dir, 'literal.txt');
      fs.writeFileSync(literal, 'eval "{{ PW_PASSWORD }}" === pw.value\neval "{{ PW_NOPE }}".length\n');
      assert.match((await sendFile(literal, { PW_PASSWORD: secret })).output, /stopped at line 2 of \S+ \(eval "\{\{ PW_NOPE \}\}"\.length\): PW_NOPE is not set/);
      assert.match((await sendFile(literal, { PW_PASSWORD: secret, PW_NOPE: 'x' })).output, /^true$\n[\s\S]*^1$/m, 'a variable in a JS string');
      assert.match((await sendFile(literal, {}, ['--no-vars'])).output, /^false$\n[\s\S]*^13$/m, '--no-vars sends it as written');
      assert.equal(await ok('eval JSON.stringify(out.textContent)'), '"Hose,Trowel|entered:-Ada  "', 'the spaces typed too');
      assert.equal(await ok('eval [area.value, gift.checked, document.querySelectorAll("x-card")[1].shadowRoot.querySelector("#qty").value, plan.value, location.pathname].join()'), 'Shipping,true,3,pro-yearly,/flow/routed');
      const all = await sendFile(file, { PW_PASSWORD: secret, PW_CODE: '555111' });
      assert.equal(all.status, 0, all.output);
      assert.match(await ok('info'), /\/other/);
      // --no-values: the step, and a variable for what was typed.
      await ok('watch off');
      await ok(`goto ${site.url}/flow`);
      await ok('watch on --no-values');
      await ok('fill [name=who] Grace');
      await waitFor(async () => /type textbox "Name"/.test(await ok('watch')), 'the typing');
      assert.doesNotMatch(await ok('watch'), /Grace/);
      await ok(`watch save ${path.join(dir, 'none.txt')}`);
      const none = fs.readFileSync(path.join(dir, 'none.txt'), 'utf8');
      assert.match(none, /^fill 'role=textbox\[name\*="Name"\]' "\{\{ PW_NAME \}\}"$/m);
      assert.match(none, /^# It needs PW_NAME set in the environment: what was typed into fields \(watch on --no-values\)/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saves an app\'s own routing as comments, a field changed again as one fill, and a click on a label once', async () => {
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pw-repl-app-'));
    const file = path.join(dir, 'app.txt');
    try {
      await ok(`goto ${site.url}/app`);
      await ok('watch on');
      // A date picker stepping through days, the app changing its URL between two of them.
      await ok('fill #day 2026-10-19');
      await ok('eval history.replaceState(null, "", "/app?day=19"); 0');
      await ok('fill #day 2026-10-20');
      await ok('fill #day 2026-10-21');
      await ok('click #search');
      await ok('click #filter');
      // Each label passes the click on to its control.
      await ok('click "text=Native"');
      await ok('click "text=Four"');
      await waitFor(async () => /click checkbox "Four stars"/.test(await ok('watch')), 'the last click');
      assert.match(await ok('watch'), /click label "Native"|check checkbox "Native"/);
      await ok(`watch save ${file}`);
      const saved = fs.readFileSync(file, 'utf8');
      assert.deepEqual(saved.split('\n').filter(l => l && !l.startsWith('#')), [
        `goto ${site.url}/app`,
        `wait 'role=textbox[name*="Day"]' 30`,
        `fill 'role=textbox[name*="Day"]' "2026-10-21"`,
        `click 'role=button[name*="Search"]'`,
        `wait 'role=button[name*="Filter"]' 30`,
        `click 'role=button[name*="Filter"]'`,
        `wait 'role=checkbox[name*="Native"]' 30`,
        `check 'role=checkbox[name*="Native"]'`,
        `click 'role=checkbox[name*="stars"]'`,
      ]);
      assert.equal(saved.match(/^# type /gm).length, 1, 'no comment for a value changed again');
      assert.match(saved, /^# the app went to \S+\/app\/search\?f=1&page=1 without loading a page$/m);
      // Run again, it ends where the watched steps did: the filter applied once, each box checked once.
      await ok('watch off');
      await ok(`goto ${site.url}/other`);
      const run = await sendFile(file);
      assert.equal(run.status, 0, run.output);
      assert.equal(await ok('eval [day.value, location.pathname + location.search, native.checked, four.getAttribute("aria-checked")].join()'),
        '2026-10-21,/app/search?f=1&page=1,true,true');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saves an element by its role and a piece of its name that finds it alone, and a made-up id last', async () => {
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pw-repl-picker-'));
    const file = path.join(dir, 'picker.txt');
    try {
      await ok(`goto ${site.url}/picker`);
      await ok('watch on');
      await ok('fill role=combobox Cancun');
      await ok('click "#radix-vue-combobox-option-v-0-17-4"');
      await ok('click "label:has-text(\'4 Stars\') button"');
      await ok('click "a[href=\'#one\']"');
      await ok('click "a[href=\'#two\']"');
      await ok('click "button >> nth=2"');
      await ok('click "button >> nth=3"');
      await ok('click #ember1234');
      await waitFor(async () => /click span/.test(await ok('watch')), 'the last click');
      await ok(`watch save ${file}`);
      const saved = fs.readFileSync(file, 'utf8');
      assert.deepEqual(saved.split('\n').filter(l => l && !l.startsWith('#') && !l.startsWith('wait ')), [
        `goto ${site.url}/picker`,
        `fill 'role=combobox[name*="Where to?"]' "Cancun"`,
        `click 'role=option[name*="Quintana Roo, Mexico"]'`,
        `click 'role=checkbox[name*="4 Stars"]'`,
        `click 'role=link[name*="From $171"]'`,
        `click 'role=link[name*="Hotel Plaza Caribe"]'`,
        `click "role=button[name*=\\"Don't say \\\\\\"hi\\\\\\"\\"]"`,
        `click 'button:text-is("Go")'`,
        `click '#ember1234'`,
      ]);
      // Run again, each finds what was clicked.
      await ok('watch off');
      await ok(`goto ${site.url}/picker`);
      const run = await sendFile(file);
      assert.equal(run.status, 0, run.output);
      assert.equal(await ok('eval out.textContent'), 'typed;cancun;4 stars;one;two;quotes;go;made-up;');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names each field\'s variable once, apart from another field\'s, the shell\'s and pw-repl\'s own', async () => {
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pw-repl-vars-'));
    const file = path.join(dir, 'vars.txt');
    // Two fields labelled Password, in a form, one labelled as a pw-repl setting is named, one as a shell
    // variable is, one with a label in Spanish, and one with no label, id or name.
    const fields = `<form onsubmit="event.preventDefault(); document.title = 'sent'"><label>Password <input type="password" id="p1"></label><label>Password <input type="password" id="p2"></label><button>Go</button></form>
<label>Socket <input id="sock"></label><label>User <input id="user"></label><label>Contraseña <input id="es"></label><div><input></div>`;
    try {
      await ok(`goto ${site.url}/other`);
      await ok(`eval document.body.innerHTML = ${JSON.stringify(fields)}; 0`);
      await ok('watch on --no-values');
      await ok('fill #p1 one');
      await ok('fill #p2 two');
      await ok('fill #p1 one');
      await ok('fill #sock three');
      await ok('fill #user four');
      await ok('fill #es five');
      await ok('fill "div > input" six');
      // The form's submit is the Enter's: the click on Go the browser sends for it is not a step.
      await ok('press #p2 Enter');
      await waitFor(async () => /press textbox "Password" Enter/.test(await ok('watch')), 'the Enter');
      assert.equal(await ok('eval document.title'), 'sent');
      assert.equal((await ok('watch')).match(/type textbox/g).length, 7);
      assert.doesNotMatch(await ok('watch'), /click button "Go"/);
      assert.match(await ok(`watch save ${file}`), /\{\{ PW_PASSWORD \}\}, \{\{ PW_PASSWORD_2 \}\}, \{\{ PW_SOCKET_2 \}\}, \{\{ PW_USER \}\}, \{\{ PW_CONTRASE_A \}\}, \{\{ PW_TEXT \}\}\./);
      const saved = fs.readFileSync(file, 'utf8');
      assert.deepEqual(saved.split('\n').filter(l => l.startsWith('fill')), [
        `fill '#p1' "{{ PW_PASSWORD }}"`,
        `fill '#p2' "{{ PW_PASSWORD_2 }}"`,
        `fill '#p1' "{{ PW_PASSWORD }}"`,
        `fill 'role=textbox[name*="Socket"]' "{{ PW_SOCKET_2 }}"`,
        `fill 'role=textbox[name*="User"]' "{{ PW_USER }}"`,
        `fill 'role=textbox[name*="Contraseña"]' "{{ PW_CONTRASE_A }}"`,
        `fill 'body > div > input' "{{ PW_TEXT }}"`,
      ], 'the same field again keeps its name; another field with the same one is numbered');
      assert.match(saved, /^press '#p2' Enter$/m);
      assert.doesNotMatch(saved, /^click/m);
      assert.match(saved, /^# It needs PW_PASSWORD, PW_PASSWORD_2, PW_SOCKET_2, PW_USER, PW_CONTRASE_A, PW_TEXT set/m);
      await ok('watch off');
      // Run on the page as it was, with decoys for the names a field must not take: the shell's USER, and
      // pw-repl's own PW_SOCKET (send has -e, so it is not used to find the REPL).
      const lines = saved.split('\n').filter(l => !l.startsWith('goto'));
      const replay = path.join(dir, 'replay.txt');
      fs.writeFileSync(replay, lines.join('\n'));
      await ok(`eval document.body.innerHTML = ${JSON.stringify(fields)}; 0`);
      const values = { PW_PASSWORD: 'v1', PW_PASSWORD_2: 'v2', PW_SOCKET_2: 'v3', PW_USER: 'v4', PW_CONTRASE_A: 'v5', PW_TEXT: 'v6' };
      const run = await sendFile(replay, { ...values, USER: 'shell-user', PW_SOCKET: '/nonexistent/decoy.sock' });
      assert.equal(run.status, 0, run.output);
      assert.equal(await ok('eval [...document.querySelectorAll("input")].map(i => i.value).join()'), 'v1,v2,v3,v4,v5,v6');
      // One command takes them too, quoted as the shell would leave it, and shown as written.
      const secret = 'it\'s "q" \\b x';
      const shown = repl.stdout.length;
      const one = await pwSend(['fill', '#p1', '{{ PW_PASSWORD }}'], { PW_PASSWORD: secret });
      assert.equal(one.status, 0, one.output);
      assert.match(repl.stdout.slice(shown), /fill #p1 "\{\{ PW_PASSWORD \}\}"/);
      assert.doesNotMatch(repl.stdout.slice(shown) + one.output, /it's/);
      assert.equal(await ok('eval p1.value'), secret);
      const unset = await pwSend(['fill', '#p1', '{{ PW_NOPE }}']);
      assert.equal(unset.status, 64);
      assert.match(unset.output, /PW_NOPE is not set/);
      assert.equal(await ok('eval p1.value'), secret, 'nothing was sent');
      assert.match((await pwSend(['--no-vars', 'eval', '"{{ PW_NOPE }}".length'])).output, /^13$/m);
      // A page's own braces, and a name not PW_'s, are typed as written: HOME is set, and stays out.
      const template = await pwSend(['fill', '#p1', 'Hi {{ name }}, {{ HOME }}'], { PW_PASSWORD: secret });
      assert.equal(template.status, 0, template.output);
      assert.equal(await ok('eval p1.value'), 'Hi {{ name }}, {{ HOME }}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      await waitFor(async () => /\?wanted$/m.test(await ok('info').then(t => t.split('\n')[0])), 'the wanted tab to be selected', 20000);
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

  it('watches a tab a link opens from its first request, and lists each page\'s under its own step', async () => {
    await ok('eval document.body.insertAdjacentHTML("beforeend", \'<a id="popup" href="/other?popup" target="_blank">New tab</a>\'); "added"');
    await ok('watch on --next-tab ?popup');
    await ok('click #popup');
    await waitFor(async () => /\?popup$/m.test((await ok('info')).split('\n')[0]), 'the new tab to be selected', 20000);
    let listed = '';
    await waitFor(async () => /#1 \S+ GET 200 \d+ms document \S+\/other\?popup$/m.test(listed = await ok('requests --all')), 'its document request', 20000);
    assert.match(listed, /--- the page loads \S+\/other\?popup\n#1 /, 'from its first page, numbered first');
    await ok('reload');
    let trail = '';
    await waitFor(async () => (trail = await ok('watch')).match(/navigate \S+\/other\?popup/g)?.length === 2, 'the reload\'s step', 20000);
    assert.match(trail, /navigate \S+\/other\?popup\n +#1 GET 200 \S+\/other\?popup\n\S+ navigate \S+\/other\?popup\n +#\d+ GET 200 \S+\/other\?popup$/m, 'each document under its own navigate step');
  });

  it('waits for one next tab at a time, and leaves another client\'s wait to it', async () => {
    const as = async (client, command) => {
      const result = await repl.runAs(client, command);
      assert.equal(result.status, 'ok', `${client}: ${command}\n${result.output}`);
      return result.output;
    };
    await as('wait-a', 'watch on --next-tab ?never-a');
    const second = await repl.runAs('wait-b', 'watch on --next-tab ?never-b');
    assert.equal(second.status, 'error');
    assert.match(second.output, /^Error: Waiting to watch the next tab that opens with a URL containing \?never-a already, for wait-a: one at a time\. modes shows it/);
    assert.match(await ok('modes'), /\?never-a \(watch off stops waiting\), for wait-a/, 'the first still waits');
    assert.match(await as('wait-b', 'watch off'), /^Waiting to watch the next tab that opens with a URL containing \?never-a, for wait-a, is left on: watch off stops only your own/);
    assert.match(await ok('modes'), /\?never-a \(watch off stops waiting\), for wait-a/);
    await as('wait-a', 'watch on --next-tab ?again-a');
    assert.match(await ok('modes'), /\?again-a \(watch off stops waiting\), for wait-a/, 'its own client may change it');
    assert.match(await as('wait-a', 'watch off'), /^Stopped waiting to watch a new tab/);
    await as('wait-b', 'watch on --next-tab ?never-b');
    assert.match(await ok('modes'), /\?never-b \(watch off stops waiting\), for wait-b/, 'once it is off, another may wait');
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
    assert.match(trail, /type textbox "Name" "secret-value"\n/, 'what was typed');
    assert.match(trail, /type textbox "Password" \(a password: not recorded\)\n/);
    assert.match(trail, /click button "Load"\n +#\d+ GET 200 \S+\/api\/data/);
    assert.match(trail, /watch save <file> +save them as commands/);
    assert.doesNotMatch(trail, /hunter2/);
    await ok(`goto ${site.url}/`);
    await waitFor(async () => /navigate http/.test(await ok('watch')), 'the navigation');
    await ok('click #go');
    await waitFor(async () => /click button "Go"/.test(await ok('watch')), 'a click after navigating');
    await ok('click #pw');
    await ok('click #typed');
    await ok('eval window.__pwReplWatch(JSON.stringify({ action: "navigate", target: "forged-navigation" }))');
    await ok('eval window.__pwReplWatch(JSON.stringify({ action: "click", target: "forged-click", t: 0 }))');
    await waitFor(async () => /forged-click/.test(trail = await ok('watch 50')), 'the page-sent click');
    assert.doesNotMatch(trail, /click textbox "Password"|my private draft|forged-navigation/);
    assert.match(trail, /click p\n/, 'an editable area is named by role only');
    assert.doesNotMatch(trail, /00:00:00\.000/, 'the page cannot set the time');
    await ok('watch off');
    await ok('click #load');
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await ok('watch 50')).match(/click button "Load"/g).length, 1);
    assert.match(await ok('watch 50'), /\[watch is off\]/);
    const bare = await ok('watch');
    assert.match(bare, /^Not watching the selected tab; \d+ steps recorded before watch off:\n/);
    assert.match(bare, /click button "Load"[\s\S]*\n\n +watch <n> [^\n]*\n +watch save <file> [^\n]*\n +watch on \[--changes\] \[--live\] +record again$/);
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
    assert.match(trail, /type textbox "Name" "Ada"\n\S+ select combobox "Color" "Blue"/);
    await ok('watch off');
  });

  it('records typing once it pauses, and Enter and Escape, with what was typed but no password', async () => {
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
    assert.match(trail, /type textbox "Name" "abc"\n/);
    assert.match(trail, /type textbox "Name" "abcdef"\n\S+ press textbox "Name" Enter/, 'typing is recorded before the Enter that ends it, with the whole value');
    assert.match(trail, /press \S+.* Escape/);
    assert.match(trail, /type textbox "Password" \(a password: not recorded\)\n\S+ press textbox "Password" Enter/);
    assert.doesNotMatch(trail, /hunter2|fill textbox "Name"/);
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

  it('adds what each step changed on screen with watch on --changes, without field values', async () => {
    await ok('reload');
    await ok('watch on --changes');
    await ok('watch new');
    await ok('type #name zzz-typed');
    await new Promise(r => setTimeout(r, 2000));
    const typed = await ok('watch new');
    assert.match(typed, /type textbox "Name" "zzz-typed"/);
    assert.doesNotMatch(typed, /^ +[+~-] .*zzz-typed/m, 'a field\'s value is not a change');
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
    assert.match(trail, /type div "my private draftCESECRET"\n/, `the typing is recorded:\n${trail}`);
    assert.doesNotMatch(trail, /^ +[+~-] .*(?:CESECRET|my private draft)/m, 'nor is what an editable area holds');
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
    assert.equal((await repl.run('wait text never shown 1')).output, 'Error: No visible text matches never shown within 1s (1 was taken as the seconds: wait text "never shown 1" waits for that text)');
    await ok('eval document.body.insertAdjacentHTML("beforeend", "<p>Showing 1</p>"); 0');
    assert.equal(await ok('wait text "Showing 1"'), 'Visible: Showing 1', 'quoted, the number is the text\'s');
    assert.match((await pwSend(['wait', 'text', 'Showing 1'])).output, /^Visible: Showing 1$/m, 'quoted in the shell, through send too');
    assert.match((await pwSend(['wait', 'text=Showing 1', '2'])).output, /^Visible: "text=Showing 1"$/m, 'a selector with a space, and the seconds');
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

  it('unsets a viewport, which counts as a mode, and keeps it through a screenshot', async () => {
    const windowSize = /^(\d+x\d+) \(the window's size\)$/.exec(await ok('viewport'))[1];
    assert.equal(await ok('viewport off'), `No viewport is set in the selected tab: ${windowSize} (the window's size)`);
    await ok('viewport 700x500');
    assert.match(await ok('modes'), /\(viewport:700x500\)/);
    assert.match((await repl.run('emulate mobile')).output, /viewport off first/, 'one screen size at a time');
    const shot = /Saved: (\S+)/.exec(await ok('screenshot'))[1];
    const png = fs.readFileSync(shot);
    fs.unlinkSync(shot);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [700, 500]);
    assert.equal(await ok('eval innerWidth + "x" + innerHeight'), '700x500', 'the screenshot kept it');
    assert.equal(await ok('viewport off'), `Viewport off: ${windowSize} (the window's size)`);
    assert.equal(await ok('eval innerWidth + "x" + innerHeight'), windowSize);
    await ok('viewport 640x480');
    assert.match(await ok('modes off'), /viewport off/);
    assert.equal(await ok('viewport'), `${windowSize} (the window's size)`);
  });

  it('screenshots a viewport wider than the window at its size after a navigation', async () => {
    const [windowWidth] = /^(\d+)x\d+ \(the window's size\)$/.exec(await ok('viewport'))[1].split('x').map(Number);
    assert.ok(windowWidth < 1200, `the window (${windowWidth} wide) is narrower than the viewport`);
    const { PNG } = require('playwright-core/lib/utilsBundle');
    // Blue where it is drawn, white where Chrome left the shot blank.
    const blueAt = (file, x, y) => {
      const image = PNG.sync.read(fs.readFileSync(file));
      fs.unlinkSync(file);
      const i = (y * image.width + (x < 0 ? image.width + x : x)) * 4;
      const [r, g, b] = image.data.slice(i, i + 3);
      return r < 50 && g < 50 && b > 200;
    };
    const shot = async command => /Saved: (\S+)/.exec(await ok(command))[1];
    // Added after each load: a data: URL's navigation did not show the crop; a page from a server does.
    const mark = () => ok('eval document.body.insertAdjacentHTML("beforeend", \'<div style="position:fixed;right:0;top:0;width:40px;height:40px;background:blue"></div><button style="position:fixed;left:1150px;top:100px;width:40px;height:40px;background:blue;border:0">far</button>\')');
    await ok(`goto ${site.url}/other`);
    await ok('viewport 1280x720');
    try {
      await mark();
      // The first shot brings the tab to the front, after which a navigation used to leave Chrome
      // drawing it at the window's size.
      assert.ok(blueAt(await shot('screenshot'), -10, 10), 'before the navigation');
      await ok(`goto ${site.url}/other?again`);
      await mark();
      assert.ok(blueAt(await shot('screenshot'), -10, 10), 'after it');
      await ok('reload');
      await mark();
      assert.ok(blueAt(await shot('screenshot --full'), -10, 10), '--full');
      await ok('reload');
      await mark();
      const ref = /button "far" \[ref=((?:f\d+)?e\d+)\]/.exec(await ok('snapshot'))[1];
      assert.ok(blueAt(await shot(`screenshot ${ref}`), 20, 20), 'an element beyond the window\'s width');
    } finally {
      await ok('viewport off');
      await ok(`goto ${site.url}/`);
    }
  });

  it('screenshots an element taller than the viewport where it is, beside the page\'s scrollbar', async () => {
    const { PNG } = require('playwright-core/lib/utilsBundle');
    // Taller than the window, at the right of a page that scrolls: its whole width is blue.
    await ok('goto data:text/html,<body style="margin:0;height:3000px"><button style="position:absolute;right:0;top:0;width:200px;height:2000px;background:blue;border:0">Tall</button>');
    const ref = /button "Tall" \[ref=((?:f\d+)?e\d+)\]/.exec(await ok('snapshot'))[1];
    const file = /Saved: (\S+)/.exec(await ok(`screenshot ${ref}`))[1];
    const image = PNG.sync.read(fs.readFileSync(file));
    fs.unlinkSync(file);
    const blue = x => { const i = (100 * image.width + x) * 4; return image.data[i] < 50 && image.data[i + 2] > 200; };
    assert.deepEqual([image.width, blue(2), blue(image.width - 3)], [200, true, true], 'not shifted by the scrollbar\'s width');
    assert.equal(await ok('eval document.adoptedStyleSheets.length'), '0', 'the page is left as it was');
    await ok(`goto ${site.url}/`);
  });

  it('types at a pace a video can show while recording, and saves when each step ran and where', { skip: FFMPEG ? false : 'no ffmpeg found: npx playwright-core install ffmpeg' }, async () => {
    const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'pw-repl-steps-'));
    try {
      // The gaps between keys, measured in the page, not timed from here.
      await ok('eval window.keys = []; document.querySelector("#name").addEventListener("keydown", () => keys.push(performance.now()))');
      const gaps = 'eval keys.slice(1).map((t, i) => t - keys[i]).every(gap => gap >= 50)';
      await ok('type #name ab');
      assert.equal(await ok(gaps), 'false', 'at once, not recording');
      await ok('eval keys.length = 0; document.querySelector("#name").value = ""');
      // Steps are saved only when asked for.
      await ok(`record on ${dir}/plain.webm --pause=0 --lead=0 --tail=0`);
      await ok('click #go');
      assert.match((await repl.run('record off --steps')).output, /--steps goes on record on/);
      assert.doesNotMatch(await ok('record off'), /Steps/);
      assert.ok(!fs.existsSync(`${dir}/plain.steps.txt`));
      assert.match(await ok(`record on ${dir}/clip.webm --steps --pause=0 --lead=0 --tail=0`), /, with its steps[,;] /);
      assert.match(await ok('record'), /, with its steps[,;] /);
      await ok('type #name abcd');
      assert.equal(await ok(gaps), 'true');
      await ok('eval keys.length = 0');
      await ok('type --delay=0 #name efg');
      assert.equal(await ok(gaps), 'false', '--delay sets its own pace');
      assert.match((await repl.run('type --delay=fast #name e')).output, /^Error: Usage: type --delay=<ms>/);
      await ok('click #go');
      await ok('mousemove 10 20');
      await ok('text #out');
      const box = await ok('eval (r => [r.x, r.y, r.width, r.height].map(Math.round).join(" "))(document.querySelector("#go").getBoundingClientRect())');
      // Scrolled in eased steps while recording, the whole distance.
      await ok('eval document.body.style.height = "3000px"');
      await ok('mousewheel 0 240');
      assert.equal(await ok('eval scrollY'), '240');
      // A new page is a step of its own, without its URL.
      await ok('click text=Other');
      await ok('wait load');
      const saved = await ok(`record off ${dir}/named.webm`);
      assert.match(saved, new RegExp(`^Saved: \\S+named\\.webm \\([^)]+\\)\\nSteps: ${dir}/named\\.steps\\.txt \\(\\d+; `), 'moved with the video');
      const lines = fs.readFileSync(`${dir}/named.steps.txt`, 'utf8').trim().split('\n');
      assert.match(lines[0], /^# pw-repl record steps, for a video of \d+x\d+, \d+\.\d\ds long$/);
      // eval may change the page, so it is a step too, logged without its code; the ones here only read it.
      assert.ok(lines.some(l => / eval$/.test(l)), 'eval, and nothing of its code');
      assert.ok(!/abcd|efg|keys/.test(lines.join('\n')), 'no typed text, and no code');
      const steps = lines.filter(l => !l.startsWith('#') && !/ eval$/.test(l)).map(l => l.split(' '));
      assert.deepEqual(steps.map(w => w.slice(6).join(' ')), ['type #name', 'type #name', 'type #name  # failed', 'click #go', 'mousemove 10 20', 'mousewheel 0 240', 'click text=Other', '(page)'], 'text reads the page, and is left out');
      assert.ok(!/\/other/.test(lines.join('\n')), 'no URL');
      for (const [t0, t1] of steps) assert.ok(Number(t0) <= Number(t1), `${t0} ${t1}`);
      assert.ok(Number(steps[3][0]) >= Number(steps[0][1]), 'in order, on the video\'s clock');
      assert.equal(steps[3].slice(2, 6).join(' '), box, 'the element it clicked');
      assert.equal(steps[4].slice(2, 6).join(' '), '10 20 0 0', 'a point');
      assert.equal(steps[2].slice(2, 6).join(' '), '- - - -');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('paces a recording: still page before and after, and a pause after each action and highlight', { skip: FFMPEG ? false : 'no ffmpeg found: npx playwright-core install ffmpeg' }, async () => {
    const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'pw-repl-pace-'));
    try {
      await ok(`record on ${dir}/clip.webm --steps`);
      await ok('click #go');
      await ok('click #go');
      await ok('highlight #go');
      await ok('highlight off');
      const saved = await ok('record off');
      // On the video's own clock: a busy machine only makes these longer.
      const length = Number(/\((\d+\.\d)s, /.exec(saved)[1]);
      const steps = fs.readFileSync(`${dir}/clip.steps.txt`, 'utf8').split('\n').filter(l => / click #go$/.test(l)).map(l => l.split(' ').map(Number));
      assert.ok(steps[0][0] >= 0.95, `the lead: first action at ${steps[0][0]}s`);
      assert.ok(steps[1][0] - steps[0][1] >= 0.7, `the pause: ${steps[0][1]}s to ${steps[1][0]}s`);
      assert.ok(length - steps[1][1] >= 1.6, `the pause and the tail: last action ended at ${steps[1][1]}s of ${length}s`);
      const boxes = fs.readFileSync(`${dir}/clip.steps.txt`, 'utf8').split('\n').filter(l => / highlight$/.test(l)).map(l => l.split(' ').map(Number));
      assert.ok(boxes[1][0] - boxes[0][1] >= 0.7, `the box shown before highlight off: ${boxes[0][1]}s to ${boxes[1][0]}s`);
      assert.match(await ok(`record on ${dir}/two.webm --pause=0 --tail=250`), /, --pause=0 --tail=250; /, 'only what differs from the defaults');
      assert.match(await ok('record'), /, --pause=0 --tail=250; /);
      assert.match((await repl.run('record off --lead=0')).output, /--lead goes on record on/);
      await ok('record off');
      assert.match((await repl.run('record on --pause=fast')).output, /--pause=<ms> takes milliseconds, from 0 to 10000 \(default 750\)/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scrolls smoothly to an element out of view while recording, and notes where it settled', { skip: FFMPEG ? false : 'no ffmpeg found: npx playwright-core install ffmpeg' }, async () => {
    const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'pw-repl-scroll-'));
    try {
      await ok('eval document.body.style.height = "4000px"; const b = document.createElement("button"); b.id = "far"; b.textContent = "Far"; b.style.cssText = "position:absolute;top:2500px;left:40px"; document.body.append(b); scrollTo(0, 0)');
      // Every place the page scrolled through, as it went: one for a jump, many for a smooth scroll.
      await ok('eval window.ys = []; addEventListener("scroll", () => ys.push(scrollY))');
      await ok(`record on ${dir}/clip.webm --steps --pause=0 --lead=0 --tail=0`);
      await ok('click #far');
      // A jump goes straight to the end; a smooth scroll passes somewhere between, however few frames it draws.
      assert.equal(await ok('eval ys.some(y => y > 0 && y < ys[ys.length - 1])'), 'true', `scrolled through ${await ok('eval ys.join(" ")')}`);
      const rect = 'eval (r => [r.x, r.y, r.width, r.height].map(Math.round).join(" "))(document.querySelector("#far").getBoundingClientRect())';
      const box = await ok(rect);
      assert.equal(await ok('eval (r => Math.abs(r.y + r.height / 2 - innerHeight / 2) <= 1)(document.querySelector("#far").getBoundingClientRect())'), 'true', 'in the middle');
      // In view already: no scroll.
      await ok('eval ys.length = 0');
      await ok('click #far');
      assert.equal(await ok('eval ys.length'), '0');
      await ok('record off');
      const steps = fs.readFileSync(`${dir}/clip.steps.txt`, 'utf8').trim().split('\n').filter(l => / click #far$/.test(l));
      assert.equal(steps[0].split(' ').slice(2, 6).join(' '), box, 'where it settled');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records the page to a video of its size and its real length, and fits a size change into it', { skip: FFMPEG ? false : 'no ffmpeg found: npx playwright-core install ffmpeg' }, async () => {
    const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'pw-repl-record-'));
    const file = require('path').join(dir, 'clip.webm');
    try {
      await ok('viewport 640x360');
      // A page that scrolls: its scrollbars are in the video, which is the viewport's size.
      await ok('eval document.body.style.height = "3000px"');
      assert.match(await ok(`record on ${file} --pause=0 --lead=0 --tail=0`), /^Recording the selected tab to \S+clip\.webm until record off/);
      assert.match(await ok('modes'), /\(viewport:640x360 record\)/);
      assert.match((await repl.run(`record on ${file}`)).output, /already being recorded/);
      await ok('eval document.body.style.background = "red"');
      await ok('viewport 320x200');
      await waitFor(async () => /changed size at/.test(await ok('record')), 'a frame of the new size');
      const saved = await ok('record off');
      const [, seconds] = /^Saved: \S+clip\.webm \((\d+\.\d)s, 640x360, \d+ KB\)\nthe page changed size at \d+\.\ds and was fitted into the first size \(help record --all\)$/.exec(saved) || [];
      assert.ok(seconds, saved);
      // The video's own length and size, as ffmpeg reads them back: the same as reported, to a frame.
      const probe = require('child_process').spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
      const [, mm, ss] = /Duration: 00:(\d\d):(\d\d\.\d\d)/.exec(probe);
      assert.ok(Math.abs(Number(mm) * 60 + Number(ss) - Number(seconds)) <= 0.1, `${probe}\nreported ${seconds}s`);
      assert.match(probe, /Video: vp8.*, 640x360/);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'owner-only, as a screenshot is');
      assert.match(await ok('record'), /not being recorded[^]*Your last recording, ended at [^:]+:\d\d:\d\d\.\d+-?[+-]?\d\d:\d\d: Saved: /);
      assert.match((await repl.run(`record on ${file}`)).output, /Recording already exists/);
      assert.match((await repl.run(`record on ${dir}/clip.gif`)).output, /a \.webm or \.mp4 file/);
      // modes off saves it before it resets the size, which the recording would otherwise end with.
      await ok('viewport 640x360');
      await ok(`record on ${dir}/second.webm --pause=0 --lead=0 --tail=0`);
      const off = await ok('modes off');
      assert.match(off, /record off \(Saved: \S+second\.webm \(\d+\.\ds, 640x360, \d+ KB\)\), viewport off/);
      assert.doesNotMatch(off, /changed size/);
      // playwright-cli's form: --filename names the file, video-stop <file> renames it, and a
      // name that cannot be used leaves it recording, and says so.
      assert.match(await ok(`video-start --filename=${dir}/cli.webm`), /Recording the selected tab to \S+\/cli\.webm /);
      const refused = await repl.run(`video-stop --filename=${dir}/cli.mp4`);
      assert.match(refused.output, /name it \.webm, not cli\.mp4; still recording to \S+\/cli\.webm/);
      assert.match(await ok(`video-stop ${dir}/renamed.webm`), /^Saved: \S+\/renamed\.webm \(/);
      assert.ok(fs.existsSync(`${dir}/renamed.webm`) && !fs.existsSync(`${dir}/cli.webm`));
      assert.match(await ok('record'), /Saved: \S+\/renamed\.webm/);
      assert.match((await repl.run('record on --bogus')).output, /record takes no --bogus/);
      assert.match((await repl.run('record on --mp4')).output, /record takes no --mp4: the file's ending picks the format, as in record on clip\.mp4$/);
      assert.match((await repl.run('video-start --size 800x600')).output, /record takes no --size: the video is the page's size; set it first with viewport/);
      await ok(`video-start --filename=${dir}/same.webm`);
      assert.match(await ok(`video-stop --filename=${dir}/same.webm`), /^Saved: \S+\/same\.webm \(/, 'named at both ends');
      // A phone's size, taken from the page as it is shown, not from a frame drawn before it reloaded.
      await ok('viewport off');
      await ok('emulate mobile');
      await ok(`record on ${dir}/phone.webm --pause=0 --lead=0 --tail=0`);
      await ok('reload');
      assert.match(await ok('record off'), /^Saved: \S+\/phone\.webm \(\d+\.\ds, 412x838, /);
      await ok('emulate off');
      // Its tab closing ends it, and record says so with no tab selected.
      await ok('tab new about:blank');
      await ok(`record on ${dir}/third.webm --pause=0 --lead=0 --tail=0`);
      assert.match(await ok('tab close'), /^Closed about:blank\nIts tab closed, which ended it\. Saved: \S+third\.webm \(/, 'tab close says so');
      assert.match(await ok('record'), /Your last recording, ended at \S+: Its tab closed, which ended it\. Saved: \S+third\.webm/);
      // Another client's record off stops it too, and both are told whose it was.
      assert.equal((await repl.runAs('rec-a', 'tab new data:text/html,owned')).status, 'ok');
      assert.equal((await repl.runAs('rec-a', `record on ${dir}/owned.webm --pause=0 --lead=0 --tail=0`)).status, 'ok');
      assert.equal((await repl.runAs('rec-b', 'tab owned')).status, 'ok');
      assert.match((await repl.runAs('rec-b', 'record off')).output, /^rec-b's record off ended rec-a's recording\. Saved: \S+owned\.webm/);
      assert.match((await repl.runAs('rec-a', 'record')).output, /Your last recording, ended at \S+: rec-b's record off ended rec-a's recording/);
      // A folder it cannot write in is refused before it stops, at either end.
      fs.mkdirSync(`${dir}/ro`, { mode: 0o555 });
      assert.match((await repl.run(`record on ${dir}/ro/x.webm`)).output, /Cannot write in \S+\/ro to save x\.webm there/);
      // A quoted file, with a space in it.
      fs.mkdirSync(`${dir}/my dir`);
      assert.match((await repl.run(`record on ${dir}/my dir/kept.webm`)).output, /record takes one file, and "\S+\/my" and "dir\/kept\.webm" are two: quote a file name with spaces in it/);
      await ok(`record on "${dir}/my dir/kept.webm" --pause=0 --lead=0 --tail=0`);
      assert.match((await repl.run(`record off ${dir}/ro/x.webm`)).output, /Cannot write in \S+\/ro to save x\.webm there; still recording to \S+\/my dir\/kept\.webm/);
      assert.match(await ok(`record off --filename='${dir}/my dir/renamed kept.webm'`), /^Saved: \S+\/my dir\/renamed kept\.webm \(/);
      const unselected = await repl.runAs('no-tab', 'record off');
      assert.equal(unselected.status, 'ok', unselected.output);
      assert.match(unselected.output, /^The selected tab is not being recorded/, 'record off with no tab selected says so too');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records an emulated viewport at its size after a navigation', { skip: FFMPEG ? false : 'no ffmpeg found: npx playwright-core install ffmpeg' }, async () => {
    const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'pw-repl-record-crop-'));
    const pending = new Set();
    const server = require('http').createServer((req, res) => {
      if (req.url === '/hold') {
        pending.add(res);
        res.on('close', () => pending.delete(res));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(req.url === '/grid'
        ? '<!doctype html><h1>WIDE PATTERN</h1><img src="/hold"><style>html,body{margin:0}body{width:2000px;height:1400px;background:repeating-linear-gradient(90deg,#f00 0 100px,#0f0 100px 200px)}</style>'
        : '<!doctype html><h1>Landing</h1>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const { PNG } = require('playwright-core/lib/utilsBundle');
    try {
      for (const [width, height] of [[640, 360], [1280, 720]]) {
        const capture = async (name, action, lastColour = 'red', checkFrame = null) => {
          const base = `${dir}/${width}-${name}`;
          await ok(`record on ${base}.webm --pause=0 --lead=0 --tail=0`);
          await action();
          // Let the browser draw several frames, without making the test depend on a time budget.
          await ok('eval new Promise(resolve => { let n = 0; const frame = () => ++n === 10 ? resolve() : requestAnimationFrame(frame); requestAnimationFrame(frame); })');
          const saved = await ok('record off');
          assert.doesNotMatch(saved, /the page changed size/, saved);
          const decoded = require('child_process').spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', `${base}.webm`, '-vsync', '0', `${base}-%03d.png`], { encoding: 'utf8' });
          assert.equal(decoded.status, 0, decoded.stderr);
          const files = fs.readdirSync(dir).filter(file => file.startsWith(`${width}-${name}-`) && file.endsWith('.png')).sort();
          assert.ok(files.length, `${name}: no decoded frames`);
          let gridFrames = 0;
          let lastRuns = [];
          let lastImage = null;
          for (const file of files) {
            const image = PNG.sync.read(fs.readFileSync(`${dir}/${file}`));
            assert.deepEqual([image.width, image.height], [width, height]);
            const runs = [];
            let colour = null;
            let start = 0;
            for (let x = 0; x < width; x += 1) {
              const i = (150 * width + x) * 4;
              const [r, g, b] = image.data.slice(i, i + 3);
              const next = r > 180 && g < 80 && b < 80 ? 'red' : g > 180 && r < 80 && b < 80 ? 'green' : null;
              if (next !== colour) {
                if (colour) runs.push({ colour, width: x - start });
                colour = next;
                start = x;
              }
            }
            if (colour) runs.push({ colour, width: width - start });
            lastRuns = runs;
            lastImage = image;
            if (runs.length < 2) continue;
            gridFrames += 1;
            assert.ok(runs.slice(0, 2).every(run => Math.abs(run.width - 100) <= 4), `${file}: ${JSON.stringify(runs.slice(0, 4))}`);
          }
          assert.ok(gridFrames, `${name}: the grid never appeared`);
          assert.equal(lastRuns[0]?.colour, lastColour, `${name}: the final page content was not captured`);
          checkFrame?.(lastImage, files.at(-1));
        };
        await ok('goto about:blank');
        await ok(`viewport ${width}x${height}`);
        await capture('navigation', async () => {
          await ok(`goto ${url}/grid`);
          await ok('wait text "WIDE PATTERN"');
          assert.equal(await ok('eval document.readyState'), 'interactive', 'record while load is still blocked');
        });
        await ok('goto about:blank');
        await capture('restart', async () => {
          await ok(`goto ${url}/grid`);
          await ok('wait text "WIDE PATTERN"');
          assert.equal(await ok('eval document.readyState'), 'interactive');
        });
        await capture('reload', async () => {
          await ok('reload');
          await ok('wait text "WIDE PATTERN"');
          assert.equal(await ok('eval document.readyState'), 'interactive');
        });
        await capture('spa', async () => {
          await ok('eval history.pushState({}, "", "#spa"); const h = document.querySelector("h1"); h.textContent = "SPA PATTERN"; h.style.cssText = "background: white; color: black; width: 300px; height: 40px; margin: 0"');
        }, 'red', (image, file) => {
          let white = 0;
          for (let y = 0; y < Math.min(50, image.height); y += 1) {
            for (let x = 0; x < Math.min(320, image.width); x += 1) {
              const i = (y * image.width + x) * 4;
              if (image.data[i] > 240 && image.data[i + 1] > 240 && image.data[i + 2] > 240) white += 1;
            }
          }
          assert.ok(white > 100, `${file}: SPA landmark was not captured`);
        });
      }
    } finally {
      for (const res of pending) res.end();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
    const missing = await repl.run(`tab new ${site.url}/no-such-page`);
    assert.equal(missing.status, 'error');
    assert.match(missing.output, /The page did not load: #\d+ \S+\/no-such-page 404, then failed: net::\S+\n/);
    assert.equal(missing.output.match(/then failed/g).length, 1, 'why, said once');
    await ok('tab close');
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

  it('puts a notice from a tab in the answer only for a client that has the tab selected', async () => {
    await repl.runAs('notice-a', `tab new ${site.url}/?notice-a`);
    await repl.runAs('notice-b', `tab new ${site.url}/?notice-b`);
    await repl.runAs('notice-b', 'route **/api/data 500 {}');
    const later = 'eval setTimeout(() => fetch("/api/data"), 100); "later"';
    const start = repl.stdout.length;
    await repl.runAs('notice-b', later);
    const other = await repl.runAs('notice-a', 'sleep 1000');
    assert.equal(other.status, 'ok', other.output);
    await waitFor(() => /Faked: #\d+ GET \S+\/api\/data -> 500/.test(repl.stdout.slice(start)), 'the fake in the pane');
    assert.doesNotMatch(other.output, /Faked:/, 'not in the answer of a client without that tab');
    await repl.runAs('notice-b', later);
    const own = await repl.runAs('notice-b', 'sleep 1000');
    assert.match(own.output, /^Faked: #\d+ GET \S+\/api\/data -> 500$/m, 'in the answer of the client that has it selected');
    await repl.runAs('notice-b', 'eval setTimeout(() => alert("hi"), 100); "later"');
    const meanwhile = await repl.runAs('notice-a', 'sleep 1000');
    assert.doesNotMatch(meanwhile.output, /Dialog/, 'a dialog in another client\'s tab either');
    assert.match(await ok('dialog dismiss'), /Dismissed/);
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
    // cdp cannot answer one, and says so ahead of the command the dialog holds up.
    const start2 = repl.stdout.length;
    let clicked = false;
    const click2 = repl.run('click #alerter').then(result => { clicked = true; return result; });
    await waitFor(() => /Dialog \[confirm\]: sure\?/.test(repl.stdout.slice(start2)), 'the dialog');
    const refused = await repl.run('cdp Page.handleJavaScriptDialog {"accept": true}');
    assert.equal(refused.status, 'error');
    assert.match(refused.output, /cdp cannot answer a dialog[^\n]*; dialog accept or dialog dismiss answers it/);
    assert.equal(clicked, false, 'refused while the click still waits on the dialog');
    await ok('dialog dismiss');
    assert.equal((await click2).status, 'ok');
    // accept alone keeps a prompt's default, as OK in the browser does.
    const start3 = repl.stdout.length;
    await ok('eval setTimeout(() => { document.querySelector("#out").textContent = prompt("Name?", "Ada"); })');
    await waitFor(() => /Dialog \[prompt\]: Name\?/.test(repl.stdout.slice(start3)), 'the prompt');
    await ok('dialog accept');
    assert.equal(await ok('text #out'), 'Ada');
  });

  it('highlights elements as playwright-cli does, as a mode that modes off and a new page end', async () => {
    const drawn = 'eval !!document.querySelector("x-pw-glass")?.shadowRoot || document.querySelectorAll("x-pw-glass").length';
    assert.match(await ok('highlight'), /^Nothing is highlighted in the selected tab\./);
    assert.equal(await ok('highlight #go --style="outline: 3px solid blue"'), 'Highlighted #go; highlight --hide #go hides it');
    assert.notEqual(await ok(drawn), 'false', 'drawn over the page');
    assert.match(await ok('highlight button'), /^Highlighted button \(all \d+ matches\);/);
    assert.match(await ok('highlight'), /^#go {2}--style="outline: 3px solid blue"\nbutton\n/);
    assert.match(await ok('modes'), /\(highlight:2\)/);
    // The page is used through it as before.
    await ok('fill #name Ada');
    await ok('click #go');
    assert.equal(await ok('text #out'), 'Hello Ada');
    assert.equal(await ok('highlight --hide #go'), 'Hid the highlight on #go');
    assert.match((await repl.run('highlight --hide #go')).output, /#go is not highlighted/);
    assert.match((await repl.run('highlight #nothing-here')).output, /No element matches #nothing-here; nothing was highlighted/);
    assert.match((await repl.run('highlight #go --style')).output, /^Error: Usage: highlight/);
    assert.match(await ok('modes off'), /1 highlight hidden/);
    assert.match(await ok('highlight'), /^Nothing is highlighted/);
    await ok('highlight #go');
    assert.equal(await ok('highlight off'), 'Hid 1 highlight');
    // A new document drops them.
    await ok('highlight #go');
    await ok('reload');
    assert.match(await ok('highlight'), /^Nothing is highlighted/);
  });

  it('draws highlights without their labels unless they are on, under a strict CSP, as a mode of the tab', async () => {
    // Black, with a button at the top left: Playwright's label is a light box just below it.
    const server = require('http').createServer((req, res) => {
      if (req.url === '/s.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end('html,body{margin:0;height:100%;background:#000}button{position:absolute;left:20px;top:20px;width:80px;height:30px}'); }
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; style-src 'self'" });
      res.end('<!doctype html><link rel=stylesheet href=/s.css><button id=pay>Pay</button>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { PNG } = require('playwright-core/lib/utilsBundle');
    // Light pixels below the button, where the label is drawn.
    const label = async () => {
      const file = /Saved: (\S+)/.exec(await ok('screenshot'))[1];
      const image = PNG.sync.read(fs.readFileSync(file));
      fs.unlinkSync(file);
      let light = 0;
      for (let y = 55; y < 120; y++) for (let x = 0; x < 300; x++) if (image.data[(y * image.width + x) * 4] > 150) light += 1;
      return light;
    };
    try {
      await ok(`goto http://127.0.0.1:${server.address().port}/`);
      await ok('highlight #pay');
      assert.equal(await label(), 0, 'no label by default');
      assert.equal(await ok('highlight --labels on'), 'Labels on in the selected tab: each highlight is labelled with its locator; highlight --labels off hides them');
      assert.ok(await label() > 100, 'the label is drawn once they are on');
      assert.match(await ok('highlight'), /^#pay\nLabels are on\./);
      assert.match(await ok('modes'), /\(highlight:1 labels\)/);
      assert.equal(await ok('highlight --labels off'), 'Labels off in the selected tab');
      assert.equal(await label(), 0, 'hidden again');
      await ok('highlight --labels on');
      assert.match(await ok('modes off'), /1 highlight hidden, labels off/);
      // Playwright made its overlay again, with this highlight.
      await ok('highlight #pay');
      assert.equal(await label(), 0, 'modes off puts the default back');
      // With a selector, for the whole tab.
      assert.equal(await ok('highlight #pay --labels on'), 'Labels on in the selected tab: each highlight is labelled with its locator; highlight --labels off hides them\nHighlighted #pay; highlight --hide #pay hides it');
      assert.ok(await label() > 100, 'labelled with a selector');
      await ok('highlight --labels off');
      // A snapshot ref's locator finds nothing in the page's code: it is drawn with one that does.
      await ok('highlight off');
      const ref = /button "Pay" \[ref=((?:f\d+)?e\d+)\]/.exec(await ok('snapshot'))[1];
      await ok(`highlight ${ref} --labels on`);
      assert.ok(await label() > 100, 'a ref\'s highlight is labelled');
      assert.match(await ok('highlight'), /^aria-ref=\S+ {2}as getByRole\('button', \{ name: 'Pay' \}\)\n/);
      assert.equal(await ok(`highlight --hide ${ref}`), `Hid the highlight on ${ref}`);
      assert.match(await ok('highlight'), /^Nothing is highlighted/);
      await ok('highlight --labels off');
      for (const bad of ['highlight --labels', 'highlight --labels maybe', 'highlight --hide #pay --labels on', 'highlight off --labels on']) {
        assert.match((await repl.run(bad)).output, /^Error: Usage: highlight/, bad);
      }
    } finally {
      await ok('highlight off');
      await ok(`goto ${site.url}/`);
      server.close();
    }
  });

  it('points the cursor at the part of an element in view, and scrolls only to one out of view', async () => {
    const drawn = 'eval (c => new DOMMatrix(getComputedStyle(c.arrow).transform).e + "," + new DOMMatrix(getComputedStyle(c.arrow).transform).f)(document[Symbol.for("pw-repl-overlay")].cursor)';
    // Cut off by the right edge, as a bug would have it; and one far below.
    await ok('goto data:text/html,<body style="margin:0"><button id=cut style="position:absolute;left:calc(100vw - 40px);top:50px;width:120px;height:30px">Cut</button><button id=far style="position:absolute;left:10px;top:3000px">Far</button>');
    try {
      await ok('cursor on #cut');
      assert.equal(await ok('eval scrollX + "," + scrollY'), '0,0', 'not scrolled into view');
      const [x, y] = (await ok(drawn)).split(',').map(Number);
      const left = Number(await ok('eval innerWidth - 40'));
      assert.ok(x > left && x < left + 40 && y === 65, `on the part in view (${x},${y})`);
      await ok('cursor on #far');
      assert.ok(Number(await ok('eval scrollY')) > 0, 'scrolled to one out of view');
    } finally {
      await ok('cursor off');
      await ok(`goto ${site.url}/`);
    }
  });

  it('shows a toast over the page as a mode of the tab, replaced by the next, and gone with toast off', async () => {
    const shown = 'eval (o => o?.toast ? o.host.isConnected + " " + o.toast.textContent + " " + getComputedStyle(o.toast).opacity : "none")(document[Symbol.for("pw-repl-overlay")])';
    assert.equal(await ok('toast'), 'No toast is up in the selected tab; toast <text> shows one');
    assert.equal(await ok('toast Filing a ticket for a damaged package'), 'Showing the toast until toast off. Read time: 2.1s (7 words; 300ms a word, at least 1.5s), which a recording waits out before the next toast, toast off or record off.');
    assert.equal(await ok(shown), 'true Filing a ticket for a damaged package 1', 'faded in by the time it returns');
    assert.match(await ok('modes'), /\(toast\)/);
    assert.match(await ok('toast'), /^A toast is up in the selected tab: "Filing a ticket for a damaged package"; toast off hides it$/);
    // Out of sight of selectors, the snapshot and text, and the page is used through it as before.
    assert.doesNotMatch(await ok('snapshot'), /Filing a ticket/);
    assert.doesNotMatch(await ok('text body'), /Filing a ticket/);
    await ok('fill #name Ada');
    await ok('click #go');
    assert.equal(await ok('text #out'), 'Hello Ada');
    assert.match(await ok('toast "Two words" --position=top --size=30 --opacity=.5 --read-time=4s'), /Read time: 4s \(--read-time\)/);
    assert.match(await ok('toast "Two words" --position=top --size=30 --opacity=.5 --read-time=25s'), /Read time: 25s \(--read-time\), .* While recording, that one can wait up to 25s: send it with -t 35\.$/);
    assert.match(await ok('toast "Two words" --position=top --size=30 --opacity=.5 --read-time=4s'), /or record off\.$/, 'no warning at 4s');
    assert.equal(await ok(shown), 'true Two words 0.5', 'the new one, replacing the old');
    assert.equal(await ok('eval document[Symbol.for("pw-repl-overlay")].toast.parentNode.childElementCount'), '1', 'one at a time');
    // A new page draws it again.
    await ok('click text=Other');
    await ok('wait load');
    await waitFor(async () => (await ok(shown)).startsWith('true Two words'), 'the toast on the new page');
    assert.match(await ok('modes off'), /toast off/);
    assert.equal(await ok(shown), 'none');
    assert.equal(await ok('count pw-repl-overlay'), '0 element(s)', 'gone with its last layer');
    // One with a duration goes by itself.
    assert.equal(await ok('toast Soon gone --duration=300ms'), 'Showing the toast for 0.3s');
    await waitFor(async () => (await ok(shown)) === 'none', 'the toast to go by itself');
    assert.equal(await ok('toast off'), 'No toast was up in the selected tab');
    for (const [bad, said] of [['toast --position=left x', /--position is top, center or bottom/], ['toast x --duration=soon', /--duration is a time/], ['toast x --size=2', /--size is the text's size in pixels/], ['toast x --duration=1s --read-time=2s', /do not go together/], ['toast --size=20', /^Error: Usage: toast <text>/]]) {
      const result = await repl.run(bad);
      assert.equal(result.status, 'error', bad);
      assert.match(result.output, said, bad);
    }
  });

  it('keeps a toast up for its read time while the tab records', { skip: FFMPEG ? false : 'no ffmpeg found: npx playwright-core install ffmpeg' }, async () => {
    const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'pw-repl-toast-'));
    try {
      await ok(`record on ${dir}/clip.webm --steps --lead=0 --tail=0 --pause=0`);
      await ok('toast One --read-time=1s');
      assert.match(await ok('toast Two --read-time=1s'), /^Waited \d\.\ds for the toast's read time \(the tab is recording\)\n/);
      assert.match(await ok('toast off'), /^Waited \d\.\ds for the toast's read time/);
      await ok('toast Three --read-time=1s');
      assert.match(await ok('record off'), /^Waited \d\.\ds for the toast's read time[\s\S]*Saved: /);
      // On the video's own clock: a busy machine only makes these longer.
      const steps = fs.readFileSync(`${dir}/clip.steps.txt`, 'utf8').split('\n').filter(l => / toast/.test(l)).map(l => [Number(l.split(' ')[0]), Number(l.split(' ')[1]), l.replace(/^(\S+ ){6}/, '')]);
      assert.deepEqual(steps.map(([, , command]) => command), ['toast One --read-time=1s', 'toast Two --read-time=1s', 'toast off', 'toast Three --read-time=1s']);
      assert.ok(steps[1][1] - steps[0][1] >= 0.95, `the second waited for the first: ${steps[0][1]}s to ${steps[1][1]}s`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('draws a cursor that goes where the REPL acts and shows its clicks, as a mode of the tab', async () => {
    const drawn = 'eval (o => o?.cursor ? o.host.isConnected + " " + new DOMMatrix(getComputedStyle(o.cursor.arrow).transform).e + "," + new DOMMatrix(getComputedStyle(o.cursor.arrow).transform).f : "none")(document[Symbol.for("pw-repl-overlay")])';
    assert.equal(await ok('cursor'), 'The cursor is off in the selected tab; cursor on shows it');
    await ok('mousemove 30 40');
    assert.match(await ok('cursor on'), /^The cursor is on, at 30, 40: /, 'where the mouse is');
    assert.equal(await ok(drawn), 'true 30,40');
    assert.match(await ok('modes'), /\(cursor\)/);
    // Out of sight of selectors, the snapshot and text, and the page is used through it as before.
    assert.doesNotMatch(await ok('snapshot'), /pw-repl-overlay|svg/);
    await ok('fill #name Ada');
    // Its rings counted as they are added: they fade, so looking for one afterwards would race it.
    await ok('eval window.rings = 0; new MutationObserver(ms => { for (const m of ms) window.rings += m.addedNodes.length; }).observe(document[Symbol.for("pw-repl-overlay")].cursor.root, { childList: true })');
    await ok('click #go');
    assert.equal(await ok('text #out'), 'Hello Ada');
    const centre = await ok('eval (r => Math.round(r.x + r.width / 2) + "," + Math.round(r.y + r.height / 2))(document.querySelector("#go").getBoundingClientRect())');
    assert.equal(await ok(drawn), `true ${centre}`, 'at the centre of what it clicked, where Playwright clicks');
    assert.equal(await ok('eval rings'), '1');
    await ok('dblclick #go');
    assert.equal(await ok('eval rings'), '3', 'one for each click');
    await ok('hover #name');
    assert.equal(await ok('eval rings'), '3', 'a hover is no click');
    await ok('mousemove 5 6');
    assert.equal(await ok(drawn), 'true 5,6');
    assert.match(await ok('cursor'), /^The cursor is on in the selected tab, at 5, 6;/);
    // The glide's wait for the element is the command's, not one more before it (a real 5s timeout).
    assert.match((await repl.run('fill #missing x')).output, /^Error: No element matches #missing \(waited 5s\)/);
    // A select's list, drawn over the page (a native one is not in recordings), and gone afterwards.
    await ok('eval document.body.insertAdjacentHTML("beforeend", "<select id=pick><option>One</option><option value=2>Two</option></select>")');
    await ok('eval window.rows = []; new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.childElementCount) rows.push([...n.children].map(c => c.textContent).join(",")); }).observe(document[Symbol.for("pw-repl-overlay")].cursor.root, { childList: true })');
    await ok('select #pick 2');
    assert.equal(await ok('eval document.querySelector("#pick").value'), '2');
    assert.equal(await ok('eval rows.join("|")'), 'One,Two');
    assert.equal(await ok('eval [...document[Symbol.for("pw-repl-overlay")].cursor.root.children].filter(c => c.tagName === "DIV" && c.childElementCount).length'), '0', 'the list is gone (a click\'s ring may still be fading)');
    await ok('eval document.querySelector("#pick").remove()');
    // A new page draws it again where it was.
    await ok('click text=Other');
    await ok('wait load');
    await waitFor(async () => /^true /.test(await ok(drawn)), 'the cursor on the new page');
    assert.match(await ok('modes off'), /cursor off/);
    assert.equal(await ok(drawn), 'none');
    assert.equal(await ok('count pw-repl-overlay'), '0 element(s)');
    // It fades in on an element asked for, as a video's first.
    await ok('goto ' + site.url + '/');
    assert.match(await ok('cursor on #go'), /^The cursor is on, at \d+, \d+: /);
    const at = await ok('eval (r => Math.round(r.x + r.width / 2) + "," + Math.round(r.y + r.height / 2))(document.querySelector("#go").getBoundingClientRect())');
    assert.equal(await ok(drawn), `true ${at}`);
    // On already: asked for a place, it glides there, and the page gets no mouse events.
    assert.match(await ok('cursor on'), /^The cursor is already on in the selected tab, at \d+, \d+; /);
    await ok('eval window.moves = 0; addEventListener("mousemove", () => moves++)');
    assert.equal(await ok('cursor on 50 60'), 'The cursor moved to 50, 60');
    await waitFor(async () => await ok(drawn) === 'true 50,60', 'the cursor at its new place');
    assert.equal(await ok('eval moves'), '0');
    assert.equal(await ok('cursor off'), 'The cursor is off');
    await ok('cursor on');
    assert.equal(await ok('cursor off'), 'The cursor is off');
    assert.equal(await ok('cursor off'), 'The cursor was not on in the selected tab');
    assert.match((await repl.run('cursor sideways')).output, /^Error: Usage: cursor \[on \[<selector> \| <x> <y>\] \| off\]/);
  });

  it('marks which of several open dialogs it answers', async () => {
    const confirmSoon = 'eval setTimeout(() => { document.querySelector("#out").textContent = "answered " + confirm("sure?"); })';
    await ok(confirmSoon);
    await ok(`tab new ${site.url}/?second`);
    const start = repl.stdout.length;
    await ok(confirmSoon);
    await waitFor(() => /Dialog \[confirm\]/.test(repl.stdout.slice(start)), 'the second dialog');
    assert.match(await ok('dialog'), /^ {2}\[\d+\] \S+\/: confirm "sure\?"\n\* \[\d+\] \S+\?second: confirm "sure\?"\n/);
    assert.match(await ok('dialog dismiss'), /^Dismissed: \[\d+\] \S+\?second:/, 'the selected tab\'s');
    assert.match(await ok('dialog'), /^\[\d+\] \S+\/: confirm/, 'one left, unmarked');
    await ok('dialog accept');
  });

  it('forgets a dialog answered in the browser', async () => {
    // Answered as the user at the browser would, on a connection of its own: one that saw it open.
    const targets = await (await fetch(`${chrome.cdpUrl}/json`)).json();
    const target = targets.find(t => t.type === 'page' && t.url === `${site.url}/`);
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const replies = new Map();
    socket.onmessage = event => { const { id } = JSON.parse(event.data); replies.get(id)?.(); };
    const send = (id, method, params = {}) => new Promise(resolve => { replies.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
    try {
      await send(1, 'Page.enable');
      const start = repl.stdout.length;
      await ok('eval setTimeout(() => { document.querySelector("#out").textContent = "answered " + confirm("sure?"); })');
      await waitFor(() => /Dialog \[confirm\]: sure\?/.test(repl.stdout.slice(start)), 'the dialog');
      assert.match(await ok('dialog'), /confirm "sure\?"/);
      await send(2, 'Page.handleJavaScriptDialog', { accept: false });
      await waitFor(async () => (await ok('dialog')) === 'No dialog is open.', 'the dialog to be gone');
      assert.equal(await ok('text #out'), 'answered false');
    } finally {
      socket.close();
    }
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
