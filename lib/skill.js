// The agent skill, stamped as it is printed with the version it came from and a hash of its text,
// so a saved copy can be told apart from the skill of the pw-repl being run.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'skill', 'SKILL.md');
const STAMP = '<!-- pw-repl skill stamp -->';

// Only the skill's own text counts: not the stamp line, nor the Custom rules the user adds to a
// saved copy. Line endings are made the same first, so a Windows checkout gets the same hash.
function hashOf(text) {
  const own = text.replace(/\r\n?/g, '\n').split('\n## Custom rules\n')[0]
    .split('\n').filter(line => line !== STAMP && !/^This skill is from pw-repl /.test(line)).join('\n').trimEnd();
  return crypto.createHash('sha256').update(own).digest('hex').slice(0, 8);
}

function current() {
  const text = fs.readFileSync(FILE, 'utf8');
  return { text, hash: hashOf(text), version: require('../package.json').version };
}

// What `pw-repl skill` prints.
function stamped() {
  const { text, hash, version } = current();
  return text.replace(STAMP, `This skill is from pw-repl ${version} (skill ${hash}).`);
}

module.exports = { STAMP, hashOf, current, stamped };
