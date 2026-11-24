// External integration: Resend (https://resend.com) sends transactional email.
// The API key is NOT in the code or the repo: it is read at runtime from AWS
// Secrets Manager (secret "shelter/resend"), cached for 5 minutes.
// Email is best-effort: a failure is logged and never breaks the business action.
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const log = require('./logger');

const secrets = new SecretsManagerClient({});
let cache = { value: null, expires: 0 };

async function config() {
  if (cache.value && cache.expires > Date.now()) return cache.value;
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.RESEND_SECRET_ID || 'shelter/resend' }));
  cache = { value: JSON.parse(result.SecretString), expires: Date.now() + 5 * 60 * 1000 };
  return cache.value;
}

async function sendEmail({ to, subject, text, template }) {
  try {
    const cfg = await config();
    if (!cfg.apiKey || cfg.apiKey.startsWith('re_REPLACE')) {
      log.warn('email skipped: Resend key not configured', { template });
      return { sent: false, reason: 'not-configured' };
    }
    // Resend's free test sender only delivers to the account owner's address;
    // cfg.testRecipient redirects every email there during the coursework demo.
    const recipient = cfg.testRecipient || to;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.from || 'Shelter Portal <onboarding@resend.dev>', to: [recipient], subject, text }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      log.warn('email rejected by Resend', { template, status: res.status });
      return { sent: false, reason: `resend-${res.status}` };
    }
    const body = await res.json().catch(() => ({}));
    log.info('email sent', { template, providerId: body.id });
    return { sent: true };
  } catch (error) {
    log.warn('email failed', { template, error: error.name });
    return { sent: false, reason: 'error' };
  }
}

module.exports = { sendEmail };
