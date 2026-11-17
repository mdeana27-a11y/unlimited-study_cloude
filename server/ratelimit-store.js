// express-rate-limit store backed by PostgreSQL, so the limit is shared by every Cloud Run instance
// (the default in-memory store would give each instance its own budget and reset on every cold start).
class PgRateLimitStore {
  constructor(db, prefix) { this.db = db; this.prefix = prefix; this.localKeys = false; }
  init(options) { this.windowMs = options.windowMs; }
  k(key) { return this.prefix + ':' + key; }
  async increment(key) {
    const r = await this.db.one(`INSERT INTO rate_limits AS r (key, hits, reset_at) VALUES (?, 1, now() + (?::double precision * interval '1 millisecond'))
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.hits + 1 END,
        reset_at = CASE WHEN r.reset_at <= now() THEN now() + (?::double precision * interval '1 millisecond') ELSE r.reset_at END
      RETURNING hits, reset_at`, [this.k(key), this.windowMs, this.windowMs]);
    return { totalHits: r.hits, resetTime: new Date(r.reset_at) };
  }
  async decrement(key) { await this.db.query('UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = ?', [this.k(key)]); }
  async resetKey(key) { await this.db.query('DELETE FROM rate_limits WHERE key = ?', [this.k(key)]); }
}
module.exports = { PgRateLimitStore };
