const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { SKIP, waitFor, startChrome, startSite, startRepl } = require('./harness');

describe('REPL against a real browser', { skip: SKIP }, () => {
  let chrome, site, repl;

  before(async () => {
    chrome = await startChrome();
    site = await startSite();
    repl = await startRepl(chrome.cdpUrl);
    const opened = await repl.run(`tab new ${site.url}/`);
    assert.equal(opened.status, 'ok', opened.output);
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

  it('reads and drives the page', async () => {
    assert.match(await ok('info'), /Title: Fixture$/m);
    await ok('fill #name => Ada');
    await ok('click #go');
    assert.equal(await ok('text #out'), 'Hello Ada');
    assert.match(await ok('links'), /"href": "http:\/\/127\.0\.0\.1:\d+\/other"/);
  });

  it('outlines the page and clicks by snapshot label', async () => {
    await ok('fill #name => Lin');
    const snap = await ok('snapshot');
    assert.match(snap, /heading "Fixture"/);
    const ref = /button "Go" \[ref=((?:f\d+)?e\d+)\]/.exec(snap)[1];
    await ok(`click aria-ref=${ref}`);
    assert.equal(await ok('text #out'), 'Hello Lin');
    assert.match(await ok('snapshot #go'), /button "Go"/);
  });

  it('watches what happens in a tab, with the requests each step caused', async () => {
    assert.match(await ok('watch'), /^Not watching the selected tab\.\n\n +watch on +record/);
    await ok('watch on');
    assert.match(await ok('watch'), /^Watching the selected tab since \S+: nothing has happened yet\n[\s\S]*watch off/);
    await ok('fill #name => secret-value');
    await ok('fill #pw => hunter2');
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
    await ok('eval window.__pwReplWatch({ action: "navigate", target: "forged-navigation" })');
    await ok('eval window.__pwReplWatch({ action: "click", target: "forged-click", t: 0 })');
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

  it('records typing once it pauses, and Enter and Escape, without the values', async () => {
    await ok('watch on');
    await ok('watch new');
    await ok('type #name => abc');
    await new Promise(r => setTimeout(r, 900));
    await ok('type #name => def');
    await ok('press #name => Enter');
    await ok('press Escape');
    await ok('type #pw => hunter2');
    await ok('press #pw => Enter');
    await ok('press #go => Enter');
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
    await ok('watch new');
    assert.equal(await ok('watch new'), 'No new steps');
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
    await ok('type #name => zzz-typed');
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
    await ok('type #composer => CESECRET');
    await new Promise(r => setTimeout(r, 1500));
    await ok('fill #name => Kim');
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
    await ok('fill #name => Quinn');
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
    await ok('fill #name => Pat');
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
    await ok('fill #name => Wu');
    await ok('click #go');
    assert.match(await ok('wait text "Hello Wu" 5'), /Visible: Hello Wu/);
    await ok('click #load');
    await new Promise(r => setTimeout(r, 300));
    assert.match(await ok('wait request /api/data 5'), /#\d+ GET 200 \S+\/api\/data/);
    await ok('click #load');
    assert.match(await ok('wait request **/api/* 5'), /\/api\/data/, 'globs work too');
    const late = await repl.run('wait request /never 1');
    assert.equal(late.status, 'error');
    assert.match(await ok('info'), /Title: Fixture$/m, 'a wait that times out does not disconnect');
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

  it('greps the snapshot by role, name or flag, with where each hit sits', async () => {
    assert.match(await ok('snapshot --grep alert'), /region "Results" › alert \[ref=(?:f\d+)?e\d+\]: Could not load results\./);
    assert.match(await ok('snapshot --grep disabled'), /region "Results" › button "Refresh Results" \[disabled\] \[ref=(?:f\d+)?e\d+\]/);
    assert.match(await ok('snapshot --grep "refresh results"'), /Refresh Results/, 'any case, quotes allowed');
    assert.match(await ok('snapshot --grep "button \\"Refresh Results\\""'), /button "Refresh Results"/, 'escaped quotes, as typed in a shell');
    assert.match(await ok('snapshot --grep nothing-like-this'), /No snapshot lines match/);
    const ref = /button "Go" \[ref=((?:f\d+)?e\d+)\]/.exec(await ok('snapshot --grep "button \"Go\""'))[1];
    assert.match(await ok(`snapshot ${ref}`), /^- button "Go"/);
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

  it('sends a CDP command', async () => {
    assert.match(await ok('cdp Runtime.evaluate {"expression":"6*7","returnByValue":true}'), /"value": 42/);
    assert.match((await repl.run('cdp Browser.close {}')).output, /reserved/);
  });

  it('caps long output unless --all is given', async () => {
    assert.match(await ok('eval "x".repeat(13000)'), /\[truncated; use --all/);
    assert.doesNotMatch(await ok('eval --all "x".repeat(13000)'), /truncated/);
  });

  it('fakes a response in the browser and proves it', async () => {
    await ok('route **/api/data 503 {"detail":"down"}');
    const faked = await ok(fetchStatus);
    assert.match(faked, /Faked: #\d+ GET .*\/api\/data -> 503/);
    assert.match(faked, /^503$/m);
    assert.match(await ok('route'), /Fake responses on the selected tab \(1\):\n +\*\*\/api\/data +503 +\{"detail":"down"\}\n\n +route <url-glob>[\s\S]*route off/);
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
    assert.match(await ok('route'), /No fake responses/);
    await ok('tab close');
    await ok('tab 1');
    assert.match(await ok('route'), /api\/other/);
    assert.equal((await repl.run('route off **/api/nothing')).status, 'error');
    await ok('route off --all');
  });

  it('refuses statuses a response cannot have', async () => {
    assert.match((await repl.run('route **/x 101 {}')).output, /200 to 599/);
  });

  it('rejects a route body that is not JSON', async () => {
    const result = await repl.run('route **/api/data 500 {nope');
    assert.equal(result.status, 'error');
    assert.match(result.output, /not valid JSON/);
  });

  it('shows a fake as faked in requests as soon as it is answered', async () => {
    await ok('route **/api/instant 418 {}');
    assert.match(await ok('eval fetch("/api/instant").then(r => r.status)'), /^418$/m);
    assert.match(await ok('requests 5 /api/instant'), /GET 418 faked \d+ms/);
    await ok('route off --all');
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
  });

  it('shows the body of a request, real or faked', async () => {
    await ok(fetchStatus);
    await ok('route **/api/data 418 {"fake":1}');
    await ok(fetchStatus);
    await ok('route off --all');
    let recent = '';
    await waitFor(async () => /GET 418 faked/.test(recent = await ok('requests 50 /api/data')), 'the requests to settle');
    // The latest one: bodies from before an earlier navigation may be gone.
    const real = [...recent.matchAll(/#(\d+) \S+ GET 200 \d+ms \S+\/api\/data/g)].pop()[1];
    const faked = /#(\d+) \S+ GET 418 faked/.exec(recent)[1];
    assert.match(await ok(`body ${real}`), /"real": true/);
    assert.match(await ok(`body #${faked}`), /"fake": 1/);
    const missing = await repl.run('body 99999');
    assert.equal(missing.status, 'error');
    assert.match(missing.output, /No request #99999/);
  });

  it('keeps console messages and uncaught errors without a capture', async () => {
    await ok('click #noisy');
    let logs = '';
    await waitFor(async () => /\[pageerror\].*boom-uncaught/.test(logs = await ok('console 50')), 'the page error');
    assert.match(logs, /\[log\] hello-log/);
    assert.match(logs, /\[error\] bad-thing/);
    await ok('eval console.log("y".repeat(10000))');
    await waitFor(async () => /y{4000}…/.test(await ok('console --all 5')), 'the long message');
    assert.doesNotMatch(await ok('console --all 5'), /y{4001}/, 'long messages are clipped when stored');
    const errors = await ok('console 50 error');
    assert.doesNotMatch(errors, /hello-log/);
    assert.match(errors, /bad-thing/);
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
    assert.match(captured, /"tag": "request",\s+"text": "GET \S+\/api\/data"/);
    assert.match(captured, /"tag": "console:log",\s+"text": "hello-log"/);
    assert.match(captured, /"tag": "pageerror",\s+"text": "[^"]*boom-uncaught/);
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

  it('reports a read-only timeout as an error and carries on', async () => {
    const result = await repl.run('text #not-on-the-page');
    assert.equal(result.status, 'error');
    assert.match(result.output, /Timeout/);
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

describe('a command with an unknown outcome', { skip: SKIP }, () => {
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

  it('disconnects the REPL and removes the socket when a changing command times out', async () => {
    const result = await repl.run('click #not-on-the-page');
    assert.equal(result.status, 'error');
    assert.match(result.output, /the REPL is disconnecting/);
    assert.equal(result.unconfirmed, true);
    await waitFor(() => repl.exited, 'the REPL to exit');
    assert.equal(fs.existsSync(repl.socket), false);
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
