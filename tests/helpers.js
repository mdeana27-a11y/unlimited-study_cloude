const os = require('os'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const request = require('supertest');
const { Client } = require('pg');
const { loadConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { seedAll } = require('../server/seed');

const ADMIN = { email: 'mostafa@test.dev', password: 'TestPassw0rd!2026' };
const made = [];
// A fresh database cloned from the migrated template + a fresh upload dir per app.
async function makeApp(over = {}, opts = {}) {
  const adminUrl = process.env.TEST_ADMIN_URL, name = opts.share ? opts.share.dbName : 't_' + crypto.randomBytes(6).toString('hex');   // opts.share: a second "instance" on the SAME database
  if (!opts.share) { const c = new Client({ connectionString: adminUrl }); await c.connect(); await c.query(`CREATE DATABASE "${name}" TEMPLATE us_template`); await c.end(); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-test-'));
  const cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
    STORAGE_DIR: dir, DATABASE_URL: adminUrl.replace(/\/[^/?]*$/, '/' + name), DB_POOL_MAX: '4', RATE_LIMIT_AUTH: '1000', RATE_LIMIT_ADMIN: '1000', ...over });
  const db = await openDb(cfg);
  if (!opts.share) await seedAll(db, cfg, { log: () => {} });
  const built = createApp({ cfg, db, googleVerifier: opts.googleVerifier, storage: opts.storage, live: opts.live ?? false, bus: opts.bus });
  const t = { ...built, cfg, db, dir, dbName: name };
  made.push(t); return t;
}
async function closeAll() {
  const adminUrl = process.env.TEST_ADMIN_URL;
  const batch = made.splice(0);
  for (const t of batch) { await t.stop?.(); await t.db.close().catch(() => {}); }
  const c = new Client({ connectionString: adminUrl }); await c.connect();
  for (const n of new Set(batch.map(t => t.dbName))) await c.query(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`).catch(() => {});
  await c.end();
}
// A cookie-keeping client that also handles CSRF like the browser would.
async function client(app) {
  const agent = request.agent(app);
  const { body } = await agent.get('/api/csrf');
  const send = (m, url) => agent[m](url).set('X-CSRF-Token', body.token);
  return { agent, csrf: body.token, get: u => agent.get(u), post: u => send('post', u), patch: u => send('patch', u), del: u => send('delete', u) };
}
// In-memory stand-in for the Google Cloud Storage client (same calls our driver makes). It tests OUR driver logic, not Google's service.
function fakeGcs() {
  const { Readable } = require('stream'); const objs = new Map(), calls = [];
  const file = n => ({
    exists: async () => [objs.has(n)], getMetadata: async () => [{ size: String(objs.get(n).length) }],
    createReadStream: o => { const b = objs.get(n); return Readable.from([o ? b.subarray(o.start, o.end + 1) : b]); },
    delete: async () => { calls.push(['delete', n]); objs.delete(n); },
  });
  return { objs, calls, bucket: () => ({ exists: async () => [true], file, upload: async (p, o) => { calls.push(['upload', o.destination, o.metadata]); objs.set(o.destination, fs.readFileSync(p)); } }) };
}
module.exports = { makeApp, client, closeAll, fakeGcs, ADMIN };
