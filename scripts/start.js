// Production entrypoint (`npm start`): migrate + seed (idempotent), then start the server.
// Fresh deploys therefore come up with the roster, subjects and the admin account without any manual step.
const { loadConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { seedAll } = require('../server/seed');

async function bootstrap(cfg, log = console.log) {
  const db = await openDb(cfg);                       // migrations run under an advisory lock, safe with several instances starting at once
  try {
    const hasAdmin = !!(await db.one('SELECT 1 AS x FROM admins WHERE email=?', [cfg.ADMIN_EMAIL]));
    if (!hasAdmin && !cfg.ADMIN_PASSWORD) throw new Error(`First start needs the ADMIN_PASSWORD environment variable (10+ chars) to create ${cfg.ADMIN_EMAIL}.`);
    return await seedAll(db, cfg, { log });
  } finally { await db.close(); }
}
module.exports = { bootstrap };

if (require.main === module) {
  (async () => { await bootstrap(loadConfig()); require('../server/index.js'); })()
    .catch(e => { console.error('\n✖ Cannot start:', e.message, '\n'); process.exit(1); });
}
