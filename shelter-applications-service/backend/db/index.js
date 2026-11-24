// Neon Postgres connection. The connection string (a secret) comes from:
//   * Lambda: AWS Secrets Manager secret DB_SECRET_ID ("shelter/applications-db"), read once and cached
//   * your PC: DATABASE_URL in backend/.env (git-ignored)
// It is never in the code, the repo or the Lambda environment variables.
const { neon } = require('@neondatabase/serverless');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

let sqlPromise;

async function connect() {
  let url = process.env.DATABASE_URL;
  if (!url) {
    const sm = new SecretsManagerClient({});
    const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ID || 'shelter/applications-db' }));
    url = JSON.parse(r.SecretString).url;
  }
  return neon(url);
}

function db() {
  if (!sqlPromise) sqlPromise = connect().catch((e) => { sqlPromise = null; throw e; });
  return sqlPromise;
}

module.exports = { db };
