import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs'; import path from 'path';
const require = createRequire(import.meta.url);
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const { loadConfig } = require('../server/config');
const { bootstrap } = require('../scripts/start');
const { makeApp } = require('./helpers');
const base = { SESSION_SECRET: 'a'.repeat(40), DATABASE_URL: 'postgres://u:p@/db?host=/cloudsql/p:r:i' };
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

describe('production configuration rules', () => {
  it('a database URL and a session secret are mandatory, with an actionable message', () => {
    expect(() => loadConfig({ SESSION_SECRET: base.SESSION_SECRET })).toThrow(/DATABASE_URL[\s\S]*DEPLOY-GOOGLE/);
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });
  it('Cloud Run: refuses local-disk uploads (ephemeral) and defaults to a 30 MB limit, proxy trust, GCS', () => {
    expect(() => loadConfig({ ...base, K_SERVICE: 'svc' })).toThrow(/ephemeral/);
    const c = loadConfig({ ...base, K_SERVICE: 'svc', GCS_BUCKET: 'my-bucket' });
    expect(c).toMatchObject({ STORAGE_DRIVER: 'gcs', MAX_UPLOAD_MB: 30, TRUST_PROXY: 1, cloudRun: true });
    expect(loadConfig({ ...base, K_SERVICE: 'svc', GCS_BUCKET: 'my-bucket', MAX_UPLOAD_MB: '10' }).MAX_UPLOAD_MB).toBe(10);
  });
  it('local development keeps local storage and a 100 MB limit; bad bucket names are rejected', () => {
    expect(loadConfig(base)).toMatchObject({ STORAGE_DRIVER: 'local', MAX_UPLOAD_MB: 100, TRUST_PROXY: 0, DB_POOL_MAX: 10 });
    expect(() => loadConfig({ ...base, GCS_BUCKET: 'Bad Bucket!' })).toThrow(/GCS_BUCKET/);
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 'gcs' })).toThrow(/GCS_BUCKET/);
  });
});

describe('npm start bootstrap on a brand-new database', () => {
  it('migrates + seeds from nothing, is idempotent, and needs ADMIN_PASSWORD only the first time', async () => {
    const t = await makeApp({ ADMIN_EMAIL: 'first@test.dev' });                                  // clone already has the test admin; make a truly empty one:
    await t.db.query('TRUNCATE students, subjects, admins RESTART IDENTITY CASCADE');
    const noPw = { ...t.cfg, ADMIN_PASSWORD: undefined };
    await expect(bootstrap(noPw, () => {})).rejects.toThrow(/ADMIN_PASSWORD/);
    const r = await bootstrap(t.cfg, () => {}); expect(r).toMatchObject({ students: 384, subjects: 8, adminCreated: true });
    expect(await bootstrap(noPw, () => {})).toMatchObject({ students: 384, subjects: 8, adminCreated: false });
    expect(await t.db.val('SELECT COUNT(*) FROM admins')).toBe(1);
  });
  it('two instances booting simultaneously do not collide or duplicate anything', async () => {
    const t = await makeApp(); await t.db.query('TRUNCATE students, subjects, admins RESTART IDENTITY CASCADE');
    const rs = await Promise.all([bootstrap(t.cfg, () => {}), bootstrap(t.cfg, () => {}), bootstrap(t.cfg, () => {})]);
    expect(rs.filter(r => r.adminCreated)).toHaveLength(1);
    expect(await t.db.val('SELECT COUNT(*) FROM students')).toBe(384); expect(await t.db.val('SELECT COUNT(*) FROM admins')).toBe(1);
  });
});

describe('deployment files agree with each other', () => {
  it('Dockerfile, cloudbuild.yaml, compose and the setup script are consistent', () => {
    const docker = read('Dockerfile'), build = read('cloudbuild.yaml'), compose = read('docker-compose.yml'), setup = read('deploy/gcp-setup.sh');
    expect(docker).toMatch(/PORT=8080/); expect(docker).toMatch(/scripts\/start\.js/); expect(docker).toMatch(/USER node/); expect(docker).toMatch(/HEALTHCHECK/);
    for (const secret of ['study-session-secret', 'study-admin-password', 'study-database-url']) { expect(build).toContain(secret); expect(setup).toContain(secret); }
    expect(build).toMatch(/--add-cloudsql-instances/); expect(build).toMatch(/GCS_BUCKET=/); expect(build).toMatch(/--port=8080/);
    expect(compose).toMatch(/postgres:16/); expect(compose).toMatch(/DATABASE_URL/);
    expect(setup).toMatch(/POSTGRES_16/); expect(setup).toMatch(/public-access-prevention/); expect(setup).toMatch(/roles\/cloudsql\.client/); expect(setup).toMatch(/\/cloudsql\//);
  });
  it('no SQLite remnants; engines pinned; credit line present; required docs exist', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain('better-sqlite3');
    expect(pkg.dependencies.pg).toBeTruthy(); expect(pkg.dependencies['@google-cloud/storage']).toBeTruthy(); expect(pkg.engines.node).toBe('22.x');
    expect(pkg.scripts.start).toBe('node scripts/start.js'); expect(pkg.description).toContain('تم تحت إنتاج Unlimited Team');
    for (const f of ['server', 'scripts']) for (const file of fs.readdirSync(path.join(root, f), { recursive: true }).filter(x => x.endsWith('.js'))) expect(read(path.join(f, file))).not.toMatch(/better-sqlite3|\.prepare\(/);
    expect(fs.existsSync(path.join(root, 'docs/DEPLOY-GOOGLE.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'client/dist/app.css')) && fs.existsSync(path.join(root, 'data/students.csv'))).toBe(true);
  });
});
