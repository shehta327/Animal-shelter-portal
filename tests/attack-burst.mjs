// Simulated suspicious activity for the monitoring evidence: 15 requests with a
// forged (unsigned) Admin token against staff-only routes. Each one is rejected
// with 401, logged as AUTH_DENIED, counted by the metric filter, and trips the
// "auth-denied-spike" alarm (threshold 10 in 5 minutes).   node tests/attack-burst.mjs
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(new URL('../infra/out/platform.env', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.includes('=')).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const forged = `${b64({ alg: 'RS256', kid: 'fake' })}.${b64({ sub: 'attacker', 'cognito:groups': ['Admin'], token_use: 'id', exp: 9999999999 })}.AAAA`;
const counts = {};
for (let i = 0; i < 15; i += 1) {
  const r = await fetch(`${env.API_URL}/api/animals`, {
    method: 'POST', headers: { Authorization: `Bearer ${forged}`, 'Content-Type': 'application/json' }, body: '{"name":"x"}'
  });
  counts[r.status] = (counts[r.status] || 0) + 1;
}
console.log('responses:', counts);
console.log('Now check: CloudWatch Logs /aws/lambda/shelter-animals-api (AUTH_DENIED) and alarm shelter-animals-api-auth-denied-spike.');
console.log('Floci evaluates alarms periodically; if it still shows OK, wait a minute and refresh.');
