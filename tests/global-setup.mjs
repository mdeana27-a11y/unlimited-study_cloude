// Tests run against a REAL PostgreSQL. Provide one with TEST_DATABASE_URL (e.g. `docker compose up -d db` ->
// postgres://postgres:postgres@localhost:5432/postgres) or, if unset, an embedded PostgreSQL binary is started (needs a non-root user).
// A template database is migrated once; every makeApp() clones it (CREATE DATABASE … TEMPLATE) so each test gets a clean database in ~50 ms.
import { createRequire } from 'module';
import os from 'os'; import fs from 'fs'; import path from 'path';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

export default async function setup() {
  let embedded = null, adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    const EmbeddedPostgres = require('embedded-postgres').default;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-pg-')), port = 54000 + Math.floor(Math.random() * 900);
    embedded = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, postgresFlags: ['-c', 'max_connections=300', '-c', 'fsync=off'] });
    await embedded.initialise(); await embedded.start();
    adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  }
  process.env.TEST_ADMIN_URL = adminUrl;
  const admin = new Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS us_template WITH (FORCE)'); await admin.query('CREATE DATABASE us_template'); await admin.end();
  const { openDb } = require('../server/db');
  const db = await openDb({ DATABASE_URL: adminUrl.replace(/\/[^/?]*$/, '/us_template'), DB_POOL_MAX: 2 });   // runs the real migrations
  await db.close();
  return async () => {
    const c = new Client({ connectionString: adminUrl }); await c.connect();
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 't\\_%'");
    for (const r of rows) await c.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
    await c.query('DROP DATABASE IF EXISTS us_template WITH (FORCE)'); await c.end();
    if (embedded) await embedded.stop();
  };
}
