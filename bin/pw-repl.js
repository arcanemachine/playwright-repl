#!/usr/bin/env node
// The one command: pw-repl run | serve | send | where | help.

const { looksLikeEndpoint } = require('../lib/client');

const USAGE = `Usage:
  pw-repl [run] [start-url]                   connect to the browser and open the prompt (the default)
  pw-repl serve [endpoint] [start-url]        the same, plus a command server (socket, port, or 127.0.0.1:port;
                                              default /tmp/playwright-repl.sock)
  pw-repl send [-e endpoint | -s session] [-t seconds] <command...>
                                              run one command in a running REPL and print its output
  pw-repl where [-e endpoint | -s session]    say which REPL send would reach
  pw-repl help [topic | command | --all]      the REPL's command reference (no REPL needed)

send uses the server when -e, $PW_ENDPOINT, or the socket ($PW_SOCKET, default /tmp/playwright-repl.sock)
is there, and the tmux session (-s, $PW_TMUX_SESSION, default playwright-repl) otherwise. If the socket
exists but nothing answers, send fails rather than fall back.
send exit status: 0 ok, 1 command error, 2 completion not confirmed, 64 usage or unreachable.

The browser must be running with --remote-debugging-port (default http://localhost:9222; set $PW_CDP_URL).`;

function usage(code = 64) {
  (code ? console.error : console.log)(USAGE);
  process.exit(code);
}

// -e, -s and -t, then the command words (unquoted words are one command).
function parseSendArgs(args, allowCommand) {
  const options = { endpoint: null, session: null, timeout: 20, command: '' };
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-e' || arg === '-s' || arg === '-t') {
      const value = args[++i];
      if (value === undefined) usage();
      if (arg === '-e') options.endpoint = value;
      if (arg === '-s') options.session = value;
      if (arg === '-t') {
        if (!/^\d+$/.test(value) || Number(value) < 1) usage();
        options.timeout = Number(value);
      }
    } else if (arg === '--') { i++; break; } else break;
  }
  const words = args.slice(i);
  if (!allowCommand && words.length) usage();
  options.command = words.join(' ').trim();
  return options;
}

function startOptions(args, serve) {
  const options = { serve, endpoint: null, startUrl: null };
  const rest = [...args];
  if (serve && rest[0] && looksLikeEndpoint(rest[0])) options.endpoint = rest.shift();
  if (rest.length > 1 || (rest[0] && rest[0].startsWith('-'))) usage();
  options.startUrl = rest[0] || null;
  return options;
}

function help(topic) {
  const helpText = require('../lib/help');
  const text = helpText.render(topic);
  if (text === null) {
    console.log(`Error: No help for ${topic}. Topics: ${Object.keys(helpText.TOPICS).join(', ')}`);
    process.exit(1);
  }
  console.log(text);
}

async function main() {
  let [subcommand, ...args] = process.argv.slice(2);
  // Bare pw-repl, or pw-repl <url>, is run.
  if (subcommand === undefined) subcommand = 'run';
  else if (subcommand.includes('://')) { args = [subcommand, ...args]; subcommand = 'run'; }
  switch (subcommand) {
    case 'run':
    case 'serve':
      return require('../lib/start').start(startOptions(args, subcommand === 'serve'));
    case 'send': {
      const options = parseSendArgs(args, true);
      // help is fixed text, so it needs no browser: answer it here.
      const asksHelp = /^help(?:\s+(.*))?$/.exec(options.command);
      if (asksHelp) return help((asksHelp[1] || '').trim());
      process.exit(await require('../lib/send').send(options));
    }
    // falls through never: process.exit above
    case 'where':
      process.exit(await require('../lib/send').where(parseSendArgs(args, false)));
    // falls through never
    case 'help':
      return help(args.join(' ').trim());
    case '-v':
    case '--version':
      return console.log(require('../package.json').version);
    case '-h':
    case '--help':
      return usage(0);
    default:
      return usage();
  }
}

main();
