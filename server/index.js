const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');

(async () => {
  const cfg = loadConfig();
  const db = await openDb(cfg);                                  // runs pending migrations under an advisory lock
  if (!(await db.one('SELECT 1 AS x FROM admins LIMIT 1'))) console.warn('⚠ No admin yet — set ADMIN_PASSWORD and start with `npm start` (it seeds), or run: npm run seed');
  const { app, repo, logger, stop } = createApp({ cfg, db });

  const purge = async () => { try { const n = await repo.purgeLogs(cfg.LOG_RETENTION_MONTHS); if (n) logger.info({ n }, 'purged old activity logs'); } catch (e) { logger.error({ err: e.message }, 'purge failed'); } };
  purge(); setInterval(purge, 24 * 3600e3).unref();

  const server = app.listen(cfg.PORT, '0.0.0.0', () => logger.info(`Unlimited Study → http://localhost:${cfg.PORT}`));
  let closing = false;
  const shutdown = () => {                                        // Cloud Run sends SIGTERM, then SIGKILL after 10 s
    if (closing) return; closing = true;
    server.close(async () => { await stop(); await db.close(); process.exit(0); });
    server.closeAllConnections();                                 // the admin panel's SSE stream would otherwise keep close() waiting forever
    setTimeout(() => process.exit(1), 8000).unref();
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
})().catch(e => { console.error('✖ Cannot start:', e.message); process.exit(1); });
