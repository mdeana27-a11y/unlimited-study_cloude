// Live admin feed across instances: every instance publishes new activity-log ids with NOTIFY and every instance LISTENs,
// so an admin connected to instance A sees a login handled by instance B. (An in-process EventEmitter alone would not.)
const CHANNEL = 'us_activity';

// `instanceId` is per app instance (per process in production), so an instance ignores only its own notifications.
function startLiveFeed({ db, repo, bus, logger, instanceId }) {
  const sub = db.listen(CHANNEL, async payload => {
    try {
      const { id, from } = JSON.parse(payload);
      if (from === instanceId) return;                   // already emitted locally by logEvent
      const row = await repo.logById(id); if (row) bus.emit('log', row);
    } catch (e) { logger?.warn({ err: e.message }, 'live feed message dropped'); }
  });
  return sub;
}
const publish = (db, id, instanceId) => db.query('SELECT pg_notify(?, ?)', [CHANNEL, JSON.stringify({ id, from: instanceId })]).catch(() => {});
module.exports = { startLiveFeed, publish, CHANNEL };
