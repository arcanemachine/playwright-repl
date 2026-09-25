const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const help = require('../lib/help');
const { commands, complete, compactSnapshot, grepSnapshot, summarizeChanges, scrubEditable, clock } = require('../lib/commands');
const { parseEndpoint, looksLikeEndpoint, DEFAULT_SOCKET } = require('../lib/client');

describe('help', () => {
  const names = Object.keys(commands);
  const listed = Object.values(help.TOPICS).flatMap(t => t.commands);

  it('covers every command, each under exactly one topic', () => {
    for (const name of names) {
      assert.ok(help.COMMANDS[name], `${name} has no help entry`);
      assert.equal(listed.filter(n => n === name).length, 1, `${name} should be in one topic`);
    }
    assert.deepEqual(Object.keys(help.COMMANDS).filter(n => !names.includes(n)), [], 'help for commands that do not exist');
  });

  it('names every topic in the overview', () => {
    for (const topic of Object.keys(help.TOPICS)) assert.match(help.render(), new RegExp(`(\\n  |   )${topic} `));
  });

  it('renders topics and commands, and nothing for unknown names', () => {
    assert.match(help.render('network'), /route <glob>/);
    assert.match(help.render('network'), /\nnetwork \[on\|off\] — [\s\S]*dev proxy/, 'a topic and a command of the same name');
    assert.match(help.render('route'), /^route <glob> <status> <json> \| off <glob> — /);
    assert.equal(help.render('nope'), null);
  });

  it('fits a normal-width pane', () => {
    const views = [help.render(), help.render('--all'), ...Object.keys(help.TOPICS).map(help.render), ...Object.keys(help.COMMANDS).map(help.render)];
    for (const line of views.join('\n').split('\n')) assert.ok(line.length <= 110, `${line.length} chars: ${line}`);
  });

  it('prints every topic and every command in full with --all', () => {
    const all = help.render('--all');
    for (const topic of Object.keys(help.TOPICS)) assert.match(all, new RegExp(`== ${topic} ==`));
    for (const [name, entry] of Object.entries(help.COMMANDS)) {
      assert.ok(all.includes(entry.usage), `${name} usage missing`);
      for (const line of (entry.detail || '').split('\n').filter(Boolean)) assert.ok(all.includes(line), `${name} detail missing`);
    }
  });
});

describe('server endpoints', () => {
  it('defaults to the shared socket', () => {
    assert.deepEqual(parseEndpoint(''), { socket: DEFAULT_SOCKET });
  });

  it('treats ports and loopback host:port as TCP', () => {
    assert.deepEqual(parseEndpoint('9230'), { host: '127.0.0.1', port: 9230 });
    assert.deepEqual(parseEndpoint('localhost:9230'), { host: 'localhost', port: 9230 });
    assert.deepEqual(parseEndpoint('[::1]:9230'), { host: '::1', port: 9230 });
  });

  it('refuses addresses other than loopback', () => {
    assert.throws(() => parseEndpoint('0.0.0.0:9230'), /non-loopback/);
    assert.throws(() => parseEndpoint('10.0.0.5:9230'), /non-loopback/);
  });

  it('treats anything else as a socket path', () => {
    assert.deepEqual(parseEndpoint('/tmp/x.sock'), { socket: '/tmp/x.sock' });
  });

  it('tells an endpoint apart from a start URL', () => {
    for (const value of ['9230', '127.0.0.1:9230', '/tmp/x.sock', './x.sock']) assert.ok(looksLikeEndpoint(value), value);
    for (const value of ['http://localhost:3000', 'https://example.com/a.sock', 'example.com']) assert.ok(!looksLikeEndpoint(value), value);
  });
});

describe('tab completion', () => {
  it('completes command names', () => {
    assert.deepEqual(complete('rou'), [['route'], 'rou']);
    assert.deepEqual(complete('snap'), [['snapshot'], 'snap']);
  });

  it('offers every command on an empty line', () => {
    assert.deepEqual(complete('')[0], Object.keys(commands).sort());
  });

  it('completes the fixed words commands take', () => {
    assert.deepEqual(complete('help net'), [['network'], 'net']);
    assert.deepEqual(complete('tab n'), [['new'], 'n']);
    assert.deepEqual(complete('network o'), [['on', 'off'], 'o']);
    assert.deepEqual(complete('watch n'), [['new'], 'n']);
    assert.deepEqual(complete('watch on --c'), [['--changes'], '--c']);
    assert.deepEqual(complete('capture o'), [['on', 'off'], 'o']);
    assert.deepEqual(complete('route o'), [['off'], 'o']);
    assert.deepEqual(complete('modes o'), [['off'], 'o']);
    assert.deepEqual(complete('route off --a'), [['--all'], '--a']);
    assert.deepEqual(complete('capture on r'), [['requests'], 'r']);
  });

  it('offers nothing where arguments are free-form', () => {
    assert.deepEqual(complete('click #g'), [[], '#g']);
  });
});

describe('compact snapshot', () => {
  it('drops unnamed wrappers, lifts their children, and keeps everything named', () => {
    const full = [
      '- generic [active] [ref=e1]:',
      '  - generic [ref=e2]:',
      '    - link "FAQ" [ref=e3] [cursor=pointer]:',
      '      - /url: /faqs',
      '      - generic [ref=e4]: FAQ',
      '  - button "Go" [ref=e5]',
      '- heading "Title" [level=1] [ref=e6]',
    ].join('\n');
    assert.equal(compactSnapshot(full), [
      '- link "FAQ" [ref=e3]:',
      '  - /url: /faqs',
      '  - generic [ref=e4]: FAQ',
      '- button "Go" [ref=e5]',
      '- heading "Title" [level=1] [ref=e6]',
    ].join('\n'));
  });
});

describe('snapshot grep', () => {
  it('prints each hit with its named ancestors, skipping unnamed wrappers and their refs', () => {
    const text = [
      '- main [ref=e1]:',
      '  - generic [ref=e2]:',
      '    - region "Results" [ref=e3]:',
      '      - button "Refresh Results" [disabled] [ref=e4]',
      '- button "Other" [ref=e5]',
    ].join('\n');
    assert.deepEqual(grepSnapshot(text, 'DISABLED'), ['main › region "Results" › button "Refresh Results" [disabled] [ref=e4]']);
    assert.deepEqual(grepSnapshot(text, 'other'), ['button "Other" [ref=e5]']);
    assert.deepEqual(grepSnapshot(text, 'nope'), []);
  });
});

describe('snapshot changes', () => {
  const before = [
    '- banner [ref=e1]:',
    '  - combobox "Search for resorts" [ref=e2]',
    '  - textbox "Check In" [ref=e3]: 2026-10-09',
    '- dialog "Privacy" [ref=e4]:',
    '  - text: We process your personal information',
    '  - button "Accept All Cookies" [ref=e5]',
    '  - link "More" [ref=e6]:',
    '    - /url: https://example.com/privacy',
  ].join('\n');
  const after = [
    '- banner [ref=e1]:',
    '  - combobox "Search for resorts" [expanded] [active] [ref=e2]: cancun',
    '  - listbox [ref=e7]:',
    '    - option "Cancún Quintana Roo, Mexico" [ref=e8]:',
    '      - generic: Cancún',
    '    - option "Canungra Queensland, Australia" [ref=e9]',
    '    - option "Cancun International (CUN)" [ref=e10]',
    '    - option "Paradisus Cancún" [ref=e11]',
    '  - textbox "Check In" [ref=e3]: 2026-10-12',
  ].join('\n');

  it('shows changed, added and removed elements once each, with what is inside', () => {
    assert.deepEqual(summarizeChanges(before, after), [
      '~ combobox "Search for resorts" [expanded]',
      '+ listbox (4 named inside): option "Cancún Quintana Roo, Mexico", option "Canungra Queensland, Aust…',
      '- dialog "Privacy": We process your personal information, button "Accept All Cookies", link "More"',
    ]);
  });

  it('leaves out field values, focus, refs and link URLs', () => {
    const text = summarizeChanges(before, after).join('\n');
    assert.doesNotMatch(text, /cancun\b|2026|active|ref=|\/url/);
    assert.deepEqual(summarizeChanges(before, before.replace(/\[ref=e\d+\]/g, '[ref=f1e9]')), []);
  });

  it('blanks out the text of editable areas, as text or as a name', () => {
    const text = ['- generic "Draft" [ref=e1]: CESECRET', '- paragraph: my private draft', '- button "Go"', '  - text: CESECRET'].join('\n');
    assert.equal(scrubEditable(text, ['CESECRET', 'my private draft']), ['- generic "Draft" [ref=e1]', '- paragraph', '- button "Go"', '  - text'].join('\n'));
    assert.equal(scrubEditable(text, []), text);
  });

  it('caps the lines per step', () => {
    const many = Array.from({ length: 9 }, (_, i) => `- button "B${i}"`).join('\n');
    const lines = summarizeChanges('', many);
    assert.equal(lines.length, 6);
    assert.equal(lines[5], '… 4 more changes');
  });
});

describe('times', () => {
  const t = Date.UTC(2026, 8, 25, 0, 16, 15, 721);
  const withZone = (zone, fn) => {
    const saved = process.env.TZ;
    process.env.TZ = zone;
    try { return fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
  };

  it('prints local time with its offset', () => {
    assert.equal(withZone('America/Edmonton', () => clock(t)), '18:16:15.721-06:00');
    assert.equal(withZone('Asia/Kolkata', () => clock(t)), '05:46:15.721+05:30');
  });

  it('marks UTC explicitly', () => {
    assert.equal(withZone('UTC', () => clock(t)), '00:16:15.721+00:00');
  });
});
