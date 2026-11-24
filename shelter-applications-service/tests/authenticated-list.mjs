// Read-only smoke test: Cognito login -> Applications API -> Neon database.
// Uses ignored local demo credentials; never prints a password or ID token.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sharedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const localOutput = join(sharedRoot, 'infra', 'out');

async function main() {
  const config = Object.fromEntries(readFileSync(join(localOutput, 'platform.env'), 'utf8')
    .split(/\r?\n/).filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]));
  const user = readFileSync(join(localOutput, 'seed-users.txt'), 'utf8')
    .split(/\r?\n/).find((line) => line.startsWith('adopter1@'));
  if (!user || !config.COGNITO_CLIENT_ID || !config.API_URL) {
    throw new Error('Local platform configuration or demo adopter is missing.');
  }
  const [email, password] = user.split(/\s+/);
  if (!password) throw new Error('Local demo adopter is missing a password.');

  const login = await fetch('http://localhost:4566/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth'
    },
    body: JSON.stringify({
      ClientId: config.COGNITO_CLIENT_ID,
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: email, PASSWORD: password }
    }),
    signal: AbortSignal.timeout(15000)
  });
  console.log(`Cognito sign-in: HTTP ${login.status}`);
  if (login.status !== 200) throw new Error('Demo adopter could not sign in.');
  const token = (await login.json()).AuthenticationResult?.IdToken;
  if (!token) throw new Error('Cognito did not return an ID token.');

  const response = await fetch(`${config.API_URL}/api/applications`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000)
  });
  console.log(`Applications list: HTTP ${response.status}`);
  if (response.status !== 200) throw new Error('Authenticated application list failed.');
  const result = await response.json();
  if (!Array.isArray(result.items) || typeof result.total !== 'number') {
    throw new Error('Application list response has an unexpected format.');
  }
  console.log('Applications list: valid JSON, Neon connection working.');
}

main().catch((error) => {
  console.error(error instanceof Error && error.message.startsWith('Local ')
    ? error.message
    : 'Test failed. Check Docker/Floci and the local demo configuration.');
  process.exitCode = 1;
});
