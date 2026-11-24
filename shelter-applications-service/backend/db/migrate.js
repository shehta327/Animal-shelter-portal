// npm run migrate : applies db/schema.sql to the Neon database in DATABASE_URL (owner login).
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Pool } = require('@neondatabase/serverless');

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL (owner connection string) in backend/.env'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await pool.end();
  console.log('Schema applied.');
})().catch((e) => { console.error(e.message); process.exit(1); });
