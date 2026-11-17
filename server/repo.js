// The ONLY place that talks SQL (PostgreSQL). Every method is async. `db` = { query, all, one, val, tx } from db.js.
const { normalizeArabic } = require('./lib/arabic');
const { cairoMidnightUtc, cairoDayKey, cairoHour, lastDayKeys } = require('./lib/time');

const KINDS = {
  lectures: { fileKind: 'lecture', cols: ['title', 'description', 'week_no'] },
  sections: { fileKind: 'section', cols: ['title', 'description', 'week_no'] },
  tasks: { fileKind: 'task', cols: ['title', 'description', 'due_at'] },
};
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
// Table/column names are interpolated only from these fixed maps, never from user input.
const OWNER_TABLE = { lecture: 'lectures', section: 'sections', task: 'tasks', subject: 'subjects' };
const setList = (cols, start = 1) => cols.map((c, i) => `${c}=$${start + i}`).join(',');   // for dynamic UPDATEs (native $n placeholders)
const like = s => `%${String(s).replace(/[\\%_]/g, m => '\\' + m)}%`;                      // escape LIKE wildcards typed by the user

function makeRepo(db) {
  const r = {
    KINDS,
    // ───────── students ─────────
    studentByCode: c => db.one('SELECT * FROM students WHERE code=?', [c]),
    studentById: id => db.one('SELECT * FROM students WHERE id=?', [id]),
    studentByEmail: e => db.one('SELECT * FROM students WHERE email=?', [e]),
    linkEmail: (id, email) => db.query('UPDATE students SET email=?, email_verified_at=now() WHERE id=?', [email, id]),
    unlinkEmail: id => db.query('UPDATE students SET email=NULL, email_verified_at=NULL WHERE id=?', [id]),
    async setActive(id, on) {
      await db.query('UPDATE students SET is_active=? WHERE id=?', [!!on, id]);
      if (!on) await r.revokeAll('student', id);
    },
    async roster({ q: term, never, page = 1, pageSize = 25 }) {
      const w = [], p = [];
      if (term) { w.push("(s.code ILIKE ? OR s.name_normalized LIKE ? OR s.email ILIKE ?)"); p.push(like(term), like(normalizeArabic(term)), like(term)); }   // names are stored normalised
      if (never) w.push("NOT EXISTS (SELECT 1 FROM activity_logs a WHERE a.student_code=s.code AND a.event='login_success')");
      const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
      const total = await db.val(`SELECT COUNT(*) FROM students s ${where}`, p);
      const rows = await db.all(`SELECT s.id,s.code,s.name,s.hall,s.seq,s.email,s.is_active,
          (SELECT MAX(ts) FROM activity_logs a WHERE a.student_code=s.code AND a.event='login_success') AS last_login,
          (SELECT COUNT(*) FROM activity_logs a WHERE a.student_code=s.code AND a.event='login_success') AS logins
        FROM students s ${where} ORDER BY s.seq NULLS FIRST, s.code LIMIT ? OFFSET ?`, [...p, pageSize, (page - 1) * pageSize]);
      return { rows, total };
    },
    // ───────── admins & sessions ─────────
    adminByEmail: e => db.one('SELECT * FROM admins WHERE email=?', [e]),
    adminById: id => db.one('SELECT * FROM admins WHERE id=?', [id]),
    createSession: s => db.query('INSERT INTO sessions (id,user_type,user_id,expires_at,ip,user_agent) VALUES (?,?,?,?,?,?)', [s.id, s.type, s.userId, s.expiresAt, s.ip, s.ua]),
    session: id => db.one('SELECT * FROM sessions WHERE id=? AND revoked_at IS NULL', [id]),
    touchSession: id => db.query('UPDATE sessions SET last_seen_at=now() WHERE id=?', [id]),
    revoke: id => db.query('UPDATE sessions SET revoked_at=now() WHERE id=? AND revoked_at IS NULL', [id]),
    revokeAll: (type, uid) => db.query('UPDATE sessions SET revoked_at=now() WHERE user_type=? AND user_id=? AND revoked_at IS NULL', [type, uid]),
    onlineStudents: () => db.val(`SELECT COUNT(DISTINCT user_id) FROM sessions WHERE user_type='student' AND revoked_at IS NULL
      AND expires_at > now() AND last_seen_at > now() - interval '5 minutes'`),
    // ───────── progressive lockout (atomic: safe with many instances) ─────────
    async lockedUntil(key) { return db.val('SELECT locked_until FROM lockouts WHERE key=? AND locked_until > now()', [key]); },
    registerFail: (key, threshold) => db.query(`INSERT INTO lockouts AS l (key,fails,locked_until,updated_at)
        VALUES (?, 1, CASE WHEN 1 >= ?::int THEN now() + interval '1 minute' END, now())
      ON CONFLICT (key) DO UPDATE SET fails = l.fails + 1, updated_at = now(),
        locked_until = CASE WHEN l.fails + 1 >= ?::int THEN now() + (LEAST(power(2, l.fails + 1 - ?::int), 60) * interval '1 minute') ELSE l.locked_until END`,   // 1,2,4,…,60 min
      [key, threshold, threshold, threshold]),
    clearFails: key => db.query('DELETE FROM lockouts WHERE key=?', [key]),
    // ───────── activity log ─────────
    log: e => db.one(`INSERT INTO activity_logs (actor_type,actor_id,student_code,student_name,email,event,method,ip,user_agent,path,meta_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`, [e.actor_type, e.actor_id ?? null, e.student_code ?? null, e.student_name ?? null,
      e.email ?? null, e.event, e.method ?? null, e.ip, e.user_agent, e.path ?? null, e.meta ? JSON.stringify(e.meta) : null]),
    logById: id => db.one('SELECT * FROM activity_logs WHERE id=?', [id]),
    async logs({ q: term, from, to, method, event, page = 1, pageSize = 25, all = false }) {
      const w = [], p = [];
      if (term) { w.push('(student_name ILIKE ? OR student_code ILIKE ? OR email ILIKE ?)'); p.push(like(term), like(term), like(term)); }
      if (from) { w.push('ts >= ?'); p.push(from); }
      if (to) { w.push('ts < ?'); p.push(to); }
      if (method) { w.push('method = ?'); p.push(method); }
      if (event) { w.push('event = ?'); p.push(event); }
      const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
      const total = await db.val(`SELECT COUNT(*) FROM activity_logs ${where}`, p);
      const rows = all ? await db.all(`SELECT * FROM activity_logs ${where} ORDER BY id DESC`, p)
        : await db.all(`SELECT * FROM activity_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...p, pageSize, (page - 1) * pageSize]);
      return { rows, total };
    },
    // Retention + housekeeping. Returns the number of purged log rows.
    async purgeLogs(months) {
      const n = (await db.query(`DELETE FROM activity_logs WHERE ts < now() - (?::double precision * interval '1 day')`, [months * 30.44])).rowCount;
      await db.query('DELETE FROM rate_limits WHERE reset_at < now()');
      await db.query("DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'");
      await db.query("DELETE FROM lockouts WHERE updated_at < now() - interval '1 day' AND (locked_until IS NULL OR locked_until < now())");
      return n;
    },
    // ───────── subjects & content ─────────
    subjects(studentId = -1) {
      return db.all(`SELECT s.*,
        (SELECT COUNT(*) FROM lectures WHERE subject_id=s.id)+(SELECT COUNT(*) FROM sections WHERE subject_id=s.id)+(SELECT COUNT(*) FROM tasks WHERE subject_id=s.id)
          +(SELECT COUNT(*) FROM files WHERE owner_kind='subject' AND owner_id=s.id) AS items_count,
        (SELECT COUNT(*) FROM lectures x WHERE x.subject_id=s.id AND x.created_at > COALESCE(v.last_visit,'epoch'::timestamptz))
          +(SELECT COUNT(*) FROM sections x WHERE x.subject_id=s.id AND x.created_at > COALESCE(v.last_visit,'epoch'::timestamptz))
          +(SELECT COUNT(*) FROM tasks x WHERE x.subject_id=s.id AND x.created_at > COALESCE(v.last_visit,'epoch'::timestamptz))
          +(SELECT COUNT(*) FROM files x WHERE x.owner_kind='subject' AND x.owner_id=s.id AND x.uploaded_at > COALESCE(v.last_visit,'epoch'::timestamptz)) AS new_count
        FROM subjects s LEFT JOIN subject_visits v ON v.subject_id=s.id AND v.student_id=? ORDER BY s.sort_order`, [studentId]);
    },
    subjectBySlug: s => db.one('SELECT * FROM subjects WHERE slug=?', [s]),
    subjectById: id => db.one('SELECT * FROM subjects WHERE id=?', [id]),
    async updateSubject(id, f) {
      const cols = Object.keys(f); if (!cols.length) return;
      await db.query(`UPDATE subjects SET ${setList(cols)} WHERE id=$${cols.length + 1}`, [...cols.map(c => f[c]), id]);
    },
    lastVisit: (sid, subj) => db.val('SELECT last_visit FROM subject_visits WHERE student_id=? AND subject_id=?', [sid, subj]),
    markVisit: (sid, subj) => db.query(`INSERT INTO subject_visits (student_id,subject_id,last_visit) VALUES (?,?,now())
      ON CONFLICT (student_id,subject_id) DO UPDATE SET last_visit=excluded.last_visit`, [sid, subj]),
    content(kind, subjectId) {
      const order = kind === 'tasks' ? 'due_at ASC NULLS LAST, id DESC' : 'week_no ASC NULLS LAST, id DESC';
      return db.all(`SELECT * FROM ${kind} WHERE subject_id=? ORDER BY ${order}`, [subjectId]);
    },
    contentItem: (kind, id) => db.one(`SELECT * FROM ${kind} WHERE id=?`, [id]),
    createContent(kind, subjectId, d) {
      const cols = KINDS[kind].cols;
      return db.val(`INSERT INTO ${kind} (subject_id,${cols.join(',')}) VALUES (?,${cols.map(() => '?').join(',')}) RETURNING id`, [subjectId, ...cols.map(c => d[c] ?? null)]);
    },
    async updateContent(kind, id, d) {
      const cols = KINDS[kind].cols.filter(c => c in d); if (!cols.length) return;
      await db.query(`UPDATE ${kind} SET ${setList(cols)} WHERE id=$${cols.length + 1}`, [...cols.map(c => d[c]), id]);
    },
    async removeContent(kind, id) {                    // returns stored filenames so the caller can delete them from storage
      const fk = KINDS[kind].fileKind;
      return db.tx(async t => {
        const names = (await t.all('SELECT stored_name FROM files WHERE owner_kind=? AND owner_id=?', [fk, id])).map(x => x.stored_name);
        await t.query('DELETE FROM files WHERE owner_kind=? AND owner_id=?', [fk, id]);
        await t.query(`DELETE FROM ${kind} WHERE id=?`, [id]);
        return names;
      });
    },
    // ───────── files ─────────
    addFile: f => db.val('INSERT INTO files (owner_kind,owner_id,original_name,stored_name,mime,size,sha256,uploaded_by) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
      [f.kind, f.ownerId, f.original, f.stored, f.mime, f.size, f.sha, f.by]),
    file: id => db.one('SELECT * FROM files WHERE id=?', [id]),
    filesOfSubject: subjectId => db.all(`SELECT id,owner_kind,owner_id,original_name,mime,size,uploaded_at FROM files WHERE
        (owner_kind='subject' AND owner_id=?) OR (owner_kind='lecture' AND owner_id IN (SELECT id FROM lectures WHERE subject_id=?))
        OR (owner_kind='section' AND owner_id IN (SELECT id FROM sections WHERE subject_id=?))
        OR (owner_kind='task' AND owner_id IN (SELECT id FROM tasks WHERE subject_id=?)) ORDER BY id`, [subjectId, subjectId, subjectId, subjectId]),
    async fileSubjectSlug(f) {
      if (f.owner_kind === 'subject') return db.val('SELECT slug FROM subjects WHERE id=?', [f.owner_id]);
      return db.val(`SELECT s.slug FROM ${OWNER_TABLE[f.owner_kind]} x JOIN subjects s ON s.id=x.subject_id WHERE x.id=?`, [f.owner_id]);
    },
    async removeFile(id) { return db.one('DELETE FROM files WHERE id=? RETURNING *', [id]); },
    async ownerExists(kind, id) { return !!(await db.one(`SELECT 1 AS x FROM ${OWNER_TABLE[kind]} WHERE id=?`, [id])); },
    // ───────── announcements ─────────
    announcements: () => db.all('SELECT * FROM announcements ORDER BY pinned DESC, id DESC'),
    addAnnouncement: a => db.val('INSERT INTO announcements (title,body,pinned) VALUES (?,?,?) RETURNING id', [a.title, a.body ?? null, !!a.pinned]),
    async updateAnnouncement(id, a) {
      const cols = Object.keys(a); if (!cols.length) return;
      await db.query(`UPDATE announcements SET ${setList(cols)} WHERE id=$${cols.length + 1}`, [...cols.map(c => (c === 'pinned' ? !!a[c] : a[c])), id]);
    },
    removeAnnouncement: id => db.query('DELETE FROM announcements WHERE id=?', [id]),
    // ───────── dashboard numbers ─────────
    async overview() {
      const day = cairoMidnightUtc(new Date()).toISOString(), week = iso(-7 * 864e5), hour = iso(-3600e3), dayAgo = iso(-864e5);
      const c = (sql, p) => db.val(sql, p);
      const [active, ever, loginsToday, loginsWeek, failedHour, failedDay, methods, online] = await Promise.all([
        c('SELECT COUNT(*) FROM students WHERE is_active'),
        c("SELECT COUNT(DISTINCT student_code) FROM activity_logs WHERE event='login_success' AND actor_type='student'"),
        c("SELECT COUNT(*) FROM activity_logs WHERE event='login_success' AND actor_type='student' AND ts>=?", [day]),
        c("SELECT COUNT(*) FROM activity_logs WHERE event='login_success' AND actor_type='student' AND ts>=?", [week]),
        c("SELECT COUNT(*) FROM activity_logs WHERE event='login_fail' AND ts>=?", [hour]),
        c("SELECT COUNT(*) FROM activity_logs WHERE event='login_fail' AND ts>=?", [dayAgo]),
        db.all("SELECT method, COUNT(*) c FROM activity_logs WHERE event='login_success' AND actor_type='student' GROUP BY method"),
        r.onlineStudents(),
      ]);
      return { online, loginsToday, loginsWeek, rosterTotal: active, everLoggedIn: ever, everPct: active ? Math.round(ever / active * 100) : 0, failedHour, failedDay, methods };
    },
    async charts() {
      const rows = await db.all("SELECT ts FROM activity_logs WHERE event='login_success' AND actor_type='student' AND ts>=?", [iso(-14 * 864e5)]);
      const perDay = {}, perHour = Array(24).fill(0);
      lastDayKeys(14).forEach(k => { perDay[k] = 0; });
      const since24 = iso(-864e5);
      rows.forEach(x => { const k = cairoDayKey(x.ts); if (k in perDay) perDay[k]++; if (x.ts >= since24) perHour[cairoHour(x.ts)]++; });
      const [perHall, perSubject, topFiles] = await Promise.all([
        db.all(`SELECT COALESCE(s.hall,'—') AS hall, COUNT(*) AS n FROM activity_logs a JOIN students s ON s.code=a.student_code
          WHERE a.event='login_success' GROUP BY s.hall ORDER BY n DESC`),
        db.all(`SELECT sb.slug, sb.title_ar, sb.title_en, COUNT(*) AS n FROM activity_logs a
          JOIN subjects sb ON sb.slug = (a.meta_json::jsonb ->> 'subject') WHERE a.event='view_subject' AND a.actor_type='student' GROUP BY sb.slug, sb.title_ar, sb.title_en ORDER BY n DESC`),
        db.all(`SELECT f.id, f.original_name AS name, COUNT(*) AS n FROM activity_logs a JOIN files f ON f.id = (a.meta_json::jsonb ->> 'fileId')::bigint
          WHERE a.event='download_file' AND a.actor_type='student' GROUP BY f.id, f.original_name ORDER BY n DESC LIMIT 8`),
      ]);
      return { perDay: Object.entries(perDay).map(([day, n]) => ({ day, n })), perHour, perHall, perSubject, topFiles };
    },
  };
  return r;
}
module.exports = { makeRepo, KINDS };
