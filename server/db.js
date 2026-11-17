// PostgreSQL (node-postgres) + versioned migrations. All SQL the app runs lives in repo.js (plus the two tiny stores below).
// Types are normalised so the rest of the code never sees driver quirks:
//   bigint -> number, timestamptz -> ISO-8601 UTC string, date -> 'YYYY-MM-DD'.
const { Pool, Client, types } = require('pg');
types.setTypeParser(20, v => Number(v));
types.setTypeParser(1184, v => new Date(v).toISOString());
types.setTypeParser(1082, v => v);

const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };   // repo SQL uses ? placeholders (no ? operators are used anywhere)
function wrap(runner) {
  const query = (sql, p = []) => runner.query(toPg(sql), p);
  return {
    query,
    all: async (sql, p) => (await query(sql, p)).rows,
    one: async (sql, p) => (await query(sql, p)).rows[0] ?? null,
    val: async (sql, p) => { const r = (await query(sql, p)).rows[0]; return r ? Object.values(r)[0] : null; },
  };
}

const MIGRATIONS = [
`CREATE TABLE students (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[0-9]{7}$'),
  name TEXT NOT NULL, name_normalized TEXT NOT NULL, name_raw TEXT,
  hall TEXT, seq INTEGER,
  email TEXT UNIQUE, email_verified_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_students_name ON students(name_normalized text_pattern_ops);
CREATE INDEX idx_students_hall ON students(hall);
CREATE TABLE admins (
  id BIGSERIAL PRIMARY KEY, display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, totp_secret TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                                   -- sha256 of the cookie token (never the token itself)
  user_type TEXT NOT NULL CHECK (user_type IN ('student','admin')), user_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
  ip TEXT, user_agent TEXT, revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_sessions_user ON sessions(user_type, user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE activity_logs (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('student','admin','anonymous')),
  actor_id BIGINT, student_code TEXT, student_name TEXT, email TEXT,
  event TEXT NOT NULL, method TEXT CHECK (method IN ('google','name_code','admin') OR method IS NULL),
  ip TEXT, user_agent TEXT, path TEXT, meta_json TEXT
);
CREATE INDEX idx_logs_ts ON activity_logs(ts DESC);
CREATE INDEX idx_logs_code ON activity_logs(student_code, ts DESC);
CREATE INDEX idx_logs_event ON activity_logs(event, ts DESC);
CREATE TABLE subjects (
  id BIGSERIAL PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
  title_ar TEXT NOT NULL, title_en TEXT NOT NULL, doctor_name TEXT, ta_names TEXT,
  has_sections BOOLEAN NOT NULL DEFAULT TRUE, has_tasks BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL DEFAULT '#22D3EE', icon TEXT NOT NULL DEFAULT 'book'
);
CREATE TABLE lectures (
  id BIGSERIAL PRIMARY KEY, subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, week_no INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sections (
  id BIGSERIAL PRIMARY KEY, subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, week_no INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE tasks (
  id BIGSERIAL PRIMARY KEY, subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, due_at DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lectures_subject ON lectures(subject_id);
CREATE INDEX idx_sections_subject ON sections(subject_id);
CREATE INDEX idx_tasks_subject ON tasks(subject_id);
CREATE TABLE files (
  id BIGSERIAL PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('lecture','section','task','subject')), owner_id BIGINT NOT NULL,
  original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE, mime TEXT, size BIGINT, sha256 TEXT,
  uploaded_by BIGINT REFERENCES admins(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_files_owner ON files(owner_kind, owner_id);
CREATE TABLE announcements (
  id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT, pinned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- "new" badges: when did this student last open this subject?
CREATE TABLE subject_visits (
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  last_visit TIMESTAMPTZ NOT NULL, PRIMARY KEY (student_id, subject_id)
);
-- progressive lockout (per code, per IP, per admin email); shared by every instance
CREATE TABLE lockouts (key TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
-- express-rate-limit counters shared by every instance (an in-memory store would give each Cloud Run instance its own budget)
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, reset_at TIMESTAMPTZ NOT NULL);
CREATE INDEX idx_rate_limits_reset ON rate_limits(reset_at);`,
];

const MIGRATION_LOCK = 727274;                // pg advisory lock: only one instance migrates at a time (Cloud Run starts several)
async function migrate(pool) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
    for (const [i, sql] of MIGRATIONS.entries()) {
      if (done.has(i + 1)) continue;
      await c.query('BEGIN');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [i + 1]); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally { await c.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {}); c.release(); }
}

function poolConfig(cfg) {
  return { connectionString: cfg.DATABASE_URL, max: cfg.DB_POOL_MAX, idleTimeoutMillis: 30e3, connectionTimeoutMillis: 10e3,
    ...(cfg.DB_SSL ? { ssl: { rejectUnauthorized: false } } : {}) };      // Cloud SQL over its unix socket needs no SSL (recommended); DB_SSL is for a public IP
}

async function openDb(cfg, { migrateOnOpen = true } = {}) {
  const pool = new Pool(poolConfig(cfg));
  pool.on('error', e => console.error('pg pool error (idle client):', e.message));    // never crash the process on a dropped idle connection
  if (migrateOnOpen) await migrate(pool);
  const db = {
    ...wrap(pool), pool,
    async tx(fn) {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await fn(wrap(c)); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    },
    // Dedicated connection for LISTEN/NOTIFY (pool connections are recycled, so they can't hold a LISTEN). Reconnects with backoff.
    listen(channel, onMessage) {
      let client, stopped = false, retry = 1000;
      const connect = async () => {
        if (stopped) return;
        client = new Client(poolConfig(cfg));
        client.on('notification', m => m.channel === channel && onMessage(m.payload));
        client.on('error', () => {}); client.on('end', () => { if (!stopped) setTimeout(connect, retry = Math.min(retry * 2, 30e3)).unref(); });
        try { await client.connect(); await client.query(`LISTEN ${channel}`); retry = 1000; }
        catch { client.end().catch(() => {}); }
      };
      connect();
      return { stop: async () => { stopped = true; await client?.end().catch(() => {}); } };
    },
    close: () => pool.end(),
  };
  return db;
}
module.exports = { openDb, migrate, MIGRATIONS, wrap };
