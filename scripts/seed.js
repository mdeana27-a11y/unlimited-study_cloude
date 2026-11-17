const { loadConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { seedAll } = require('../server/seed');
(async () => { const cfg = loadConfig(), db = await openDb(cfg); try { await seedAll(db, cfg); } finally { await db.close(); } })()
  .catch(e => { console.error(e.message); process.exit(1); });
