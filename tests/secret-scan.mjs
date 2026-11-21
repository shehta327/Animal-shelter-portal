// Secret exposure review: scans the files git would commit AND the whole commit history
// of each repo folder given (default: this repo). Usage:
//   node tests/secret-scan.mjs                        (this repo)
//   node tests/secret-scan.mjs ..\shelter-visits-service ..\shelter-animals-service ...
// Exit code 1 if anything that looks like a real secret is found. Matches are masked.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RULES = [
  ['Resend API key', /\bre_[A-Za-z0-9]{16,}\b/],
  ['Postgres URL with password', /postgres(?:ql)?:\/\/[^:\s'"]+:[^@\s'"]{6,}@[^\s'"]+/],
  ['AWS access key id', /\b(AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Generic secret assignment', /\b(?:password|secret|api_?key|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i]
];
const mask = (s) => `${s.slice(0, 6)}…(${s.length} chars)`;
const repos = process.argv.slice(2).length ? process.argv.slice(2) : ['.'];
let found = 0;

for (const repo of repos) {
  const dir = path.resolve(repo);
  const git = (cmd) => execSync(`git -C "${dir}" ${cmd}`, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  let files;
  try { files = git('ls-files --cached --others --exclude-standard').split('\n').filter(Boolean); }
  catch { console.log(`${repo}: not a git repository, skipped`); continue; }
  console.log(`\n${repo}: ${files.length} files that git would commit`);
  for (const ignored of ['.env', 'backend/.env', 'infra/out/seed-users.txt']) {
    if (files.includes(ignored)) { console.log(`  FOUND  ${ignored} is NOT ignored`); found += 1; }
  }
  for (const f of files) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p) || fs.statSync(p).size > 2e6 || f.includes('node_modules/')) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const [name, re] of RULES) {
      const m = text.match(re);
      if (m && !/REPLACE|example|<|YOUR-|XXXX/i.test(m[0])) { console.log(`  FOUND  ${name} in ${f}: ${mask(m[0])}`); found += 1; }
    }
  }
  let history = '';
  try { history = git('log --all -p --no-color'); } catch { /* no commits yet */ }
  for (const [name, re] of RULES) {
    const all = history.match(new RegExp(re.source, `${re.flags}g`)) || [];
    for (const m of all.filter((x) => !/REPLACE|example|<|YOUR-|XXXX/i.test(x))) { console.log(`  FOUND  ${name} in commit history: ${mask(m)}`); found += 1; }
  }
  console.log(`  history checked: ${history ? history.split('\ncommit ').length : 0} commit(s)`);
}
console.log(found ? `\n${found} possible secret(s) found. Remove them, rotate the key, and rewrite history if it was pushed.` : '\nNo secrets found.');
process.exit(found ? 1 : 0);
