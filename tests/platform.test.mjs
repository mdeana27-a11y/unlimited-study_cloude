import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs'; import path from 'path';
const require = createRequire(import.meta.url);
const request = require('supertest');
const { EventEmitter } = require('events');
const { makeApp, client, fakeGcs, ADMIN } = require('./helpers');
const { gcsDriver } = require('../server/storage');
const { openDb } = require('../server/db');
const S = { name: 'احمد بلال اسماعيل عبدالرحمن', code: '2570010' };
const BIG = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5000, 'A')]);
const until = async (fn, ms = 4000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 40)); } };

describe('Cloud Storage driver (against an in-memory fake of the GCS client)', () => {
  it('upload -> object in the bucket (private, content-type set) -> authenticated download -> delete removes the object', async () => {
    const gcs = fakeGcs(), t = await makeApp({ GCS_BUCKET: 'unlimited-study-files' }, { storage: gcsDriver('unlimited-study-files', { client: gcs }) });
    const admin = await client(t.app); await admin.post('/api/auth/admin').send(ADMIN);
    const stu = await client(t.app); await stu.post('/api/auth/login').send(S);
    const sid = (await t.repo.subjectBySlug('web-applications')).id;
    const lec = (await admin.post('/api/admin/lectures').send({ subject_id: sid, title: 'L' })).body.id;
    const up = await admin.post('/api/admin/files').field('owner_kind', 'lecture').field('owner_id', String(lec)).attach('files', BIG, { filename: 'محاضرة.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    const row = await t.repo.file(up.body.files[0].id);
    expect(gcs.objs.has(row.stored_name)).toBe(true); expect(gcs.objs.get(row.stored_name).equals(BIG)).toBe(true);
    expect(gcs.calls.find(c => c[0] === 'upload')[2]).toMatchObject({ contentType: 'application/pdf', cacheControl: 'private, no-store' });
    expect(fs.existsSync(path.join(t.cfg.UPLOAD_DIR, row.stored_name))).toBe(false);             // nothing on the (ephemeral) local disk
    expect(fs.readdirSync(t.cfg.TMP_UPLOAD_DIR).includes(row.stored_name)).toBe(false);          // temp copy cleaned up
    expect((await request(t.app).get(`/api/files/${row.id}`)).status).toBe(401);                 // anonymous: no
    const dl = await stu.get(`/api/files/${row.id}`).buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(dl.status).toBe(200); expect(dl.body.equals(BIG)).toBe(true);
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename=.*\.pdf.*UTF-8''/); expect(dl.headers['content-length']).toBe(String(BIG.length));
    expect(dl.headers['x-content-type-options']).toBe('nosniff'); expect(dl.headers['cache-control']).toMatch(/private/);
    expect((await admin.del(`/api/admin/files/${row.id}`)).status).toBe(200);
    expect(gcs.objs.has(row.stored_name)).toBe(false);
    expect((await stu.get(`/api/files/${row.id}`)).status).toBe(404);
  });
  it('deleting a lecture deletes its objects too; a missing object is a clean 404, not a crash', async () => {
    const gcs = fakeGcs(), t = await makeApp({ GCS_BUCKET: 'bkt' }, { storage: gcsDriver('bkt', { client: gcs }) });
    const admin = await client(t.app); await admin.post('/api/auth/admin').send(ADMIN);
    const stu = await client(t.app); await stu.post('/api/auth/login').send(S);
    const sid = (await t.repo.subjectBySlug('web-applications')).id;
    const lec = (await admin.post('/api/admin/lectures').send({ subject_id: sid, title: 'L' })).body.id;
    const f = (await admin.post('/api/admin/files').field('owner_kind', 'lecture').field('owner_id', String(lec)).attach('files', BIG, 'a.pdf')).body.files[0].id;
    const stored = (await t.repo.file(f)).stored_name;
    gcs.objs.delete(stored);                                                                       // object vanished from the bucket
    expect((await stu.get(`/api/files/${f}`)).status).toBe(404);
    gcs.objs.set(stored, BIG);
    expect((await admin.del(`/api/admin/lectures/${lec}`)).status).toBe(200);
    expect(gcs.objs.size).toBe(0); expect(await t.repo.file(f)).toBeNull();
  });
  it('HTTP Range works (video seeking): 206 + exact bytes, suffix ranges, 416 when unsatisfiable', async () => {
    const t = await makeApp(); const admin = await client(t.app); await admin.post('/api/auth/admin').send(ADMIN);
    const stu = await client(t.app); await stu.post('/api/auth/login').send(S);
    const sid = (await t.repo.subjectBySlug('web-applications')).id;
    const f = (await admin.post('/api/admin/files').field('owner_kind', 'subject').field('owner_id', String(sid)).attach('files', BIG, 'video.mp4')).body.files[0].id;
    const get = r => stu.get(`/api/files/${f}`).set('Range', r).buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    const a = await get('bytes=0-9'); expect(a.status).toBe(206); expect(a.headers['content-range']).toBe(`bytes 0-9/${BIG.length}`); expect(a.body.equals(BIG.subarray(0, 10))).toBe(true);
    const b = await get('bytes=100-'); expect(b.status).toBe(206); expect(b.body.equals(BIG.subarray(100))).toBe(true);
    const c = await get('bytes=-20'); expect(c.status).toBe(206); expect(c.body.equals(BIG.subarray(BIG.length - 20))).toBe(true);
    expect((await get(`bytes=${BIG.length + 5}-`)).status).toBe(416);
    expect((await stu.get(`/api/files/${f}`).set('Range', 'bytes=abc')).status).toBe(200);        // garbage header is ignored
  });
  it('a failed upload leaves no orphan objects (storage error after the first file)', async () => {
    const gcs = fakeGcs(); let n = 0; const bucket = gcs.bucket();
    const flaky = { bucket: () => ({ ...bucket, upload: async (p, o) => { if (++n === 2) throw new Error('boom'); return bucket.upload(p, o); } }) };
    const t = await makeApp({ GCS_BUCKET: 'bkt' }, { storage: gcsDriver('bkt', { client: flaky }) });
    const admin = await client(t.app); await admin.post('/api/auth/admin').send(ADMIN);
    const sid = (await t.repo.subjectBySlug('web-applications')).id;
    const r = await admin.post('/api/admin/files').field('owner_kind', 'subject').field('owner_id', String(sid)).attach('files', BIG, 'a.pdf').attach('files', BIG, 'b.pdf');
    expect(r.status).toBe(500); expect(gcs.objs.size).toBe(0);
  });
  it('/readyz reports storage + database; 503 when the bucket is unreachable; /healthz stays up', async () => {
    const ok = await makeApp(); expect((await request(ok.app).get('/readyz')).body).toEqual({ ok: true, storage: 'local' });
    const bad = { name: 'gcs', check: async () => { throw new Error('bucket gone'); } };
    const t = await makeApp({}, { storage: bad });
    expect((await request(t.app).get('/readyz')).status).toBe(503); expect((await request(t.app).get('/healthz')).status).toBe(200);
  });
});

describe('several instances on one database (Cloud Run scale-out)', () => {
  it('migrations are idempotent and safe when several instances start at the same time', async () => {
    const t = await makeApp();
    const dbs = await Promise.all([1, 2, 3, 4].map(() => openDb({ ...t.cfg, DB_POOL_MAX: 2 })));
    expect(await t.db.val('SELECT COUNT(*) FROM schema_migrations')).toBe(1);
    await Promise.all(dbs.map(d => d.close()));
  });
  it('lockouts are atomic: 20 parallel failures from different instances count exactly 20 and lock', async () => {
    const t = await makeApp(), t2 = await makeApp({}, { share: t });
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? t : t2).repo.registerFail('code:1234567', 5)));
    expect(await t.db.val("SELECT fails FROM lockouts WHERE key='code:1234567'")).toBe(20);
    expect(await t2.repo.lockedUntil('code:1234567')).toBeTruthy();
    await t.repo.clearFails('code:1234567'); expect(await t2.repo.lockedUntil('code:1234567')).toBeNull();
  });
  it('the login rate limit is shared by every instance (not per instance)', async () => {
    const a = await makeApp({ RATE_LIMIT_AUTH: '4' }), b = await makeApp({ RATE_LIMIT_AUTH: '4' }, { share: a });
    const ca = await client(a.app), cb = await client(b.app);
    const codes = [];
    for (const c of [ca, cb, ca, cb, ca, cb]) codes.push((await c.post('/api/auth/login').send({ name: 'ابراهيم احمد رمضان احمد', code: '2570' + String(codes.length).padStart(3, '0') })).status);
    expect(codes.filter(x => x === 429).length).toBeGreaterThanOrEqual(2);                       // 4 allowed in total across both
    expect(codes.slice(0, 4).every(x => x !== 429)).toBe(true);
  });
  it('a session created on instance A is valid on instance B (sessions live in PostgreSQL)', async () => {
    const a = await makeApp(), b = await makeApp({}, { share: a });
    const login = await request(a.app).get('/api/csrf'); const csrf = login.body.token, ck = login.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    const r = await request(a.app).post('/api/auth/login').set('Cookie', ck).set('X-CSRF-Token', csrf).send(S);
    const cookie = [ck, ...r.headers['set-cookie'].map(c => c.split(';')[0])].join('; ');
    expect((await request(b.app).get('/api/me').set('Cookie', cookie)).body.user.code).toBe(S.code);
  });
  it('live admin feed crosses instances via LISTEN/NOTIFY (and does not double-deliver locally)', async () => {
    const busA = new EventEmitter(), busB = new EventEmitter();
    const a = await makeApp({}, { live: true, bus: busA }), b = await makeApp({}, { share: a, live: true, bus: busB });
    await new Promise(r => setTimeout(r, 400));                                                   // let both LISTENers connect
    const seenA = []; busA.on('log', row => seenA.push(row));
    const cb = await client(b.app); await cb.post('/api/auth/login').send(S);                    // handled by instance B
    const row = await until(() => seenA.find(r => r.event === 'login_success'));
    expect(row).toMatchObject({ student_code: S.code, method: 'name_code' });
    const seenB = []; busB.on('log', r => seenB.push(r.id)); await cb.post('/api/auth/logout');
    await new Promise(r => setTimeout(r, 400)); expect(seenB.length).toBe(new Set(seenB).size); expect(seenB.length).toBe(1);   // once, not twice
  });
});

describe('PostgreSQL specifics', () => {
  it('LIKE wildcards typed by the user are literal (no accidental match-all)', async () => {
    const t = await makeApp();
    expect((await t.repo.roster({ q: '%' })).total).toBe(0); expect((await t.repo.roster({ q: '_' })).total).toBe(0);
    expect((await t.repo.logs({ q: '%' })).total).toBe(0);
  });
  it('types are normalised: counts are numbers, timestamps are ISO strings, dates are plain days', async () => {
    const t = await makeApp(); const sid = (await t.repo.subjectBySlug('subject-8')).id;
    const id = await t.repo.createContent('tasks', sid, { title: 'x', due_at: '2026-12-01' });
    const task = await t.repo.contentItem('tasks', id);
    expect(task.due_at).toBe('2026-12-01'); expect(task.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/); expect(typeof task.id).toBe('number');
    expect(typeof (await t.repo.overview()).rosterTotal).toBe('number');
  });
  it('unique violations surface as 409, not 500', async () => {
    const t = await makeApp(); const admin = await client(t.app); await admin.post('/api/auth/admin').send(ADMIN);
    await expect(t.db.query("INSERT INTO subjects (slug,title_ar,title_en) VALUES ('web-applications','a','b')")).rejects.toMatchObject({ code: '23505' });
  });
  it('SQL-injection attempts in search boxes are inert', async () => {
    const t = await makeApp(); const admin = await client(t.app); await admin.post('/api/auth/admin').send(ADMIN);
    const r = await admin.get("/api/admin/roster?q=" + encodeURIComponent("'; DROP TABLE students; --")); expect(r.status).toBe(200); expect(r.body.total).toBe(0);
    expect(await t.db.val('SELECT COUNT(*) FROM students')).toBe(384);
  });
});
