// File storage for lectures/sections/tasks. Two drivers behind one interface:
//   gcs   -> Google Cloud Storage (private bucket, files only ever leave through the authenticated download route)
//   local -> a directory on a persistent disk (dev, VPS, Render disk, docker volume)
// Cloud Run's filesystem is ephemeral, so config.js refuses `local` there.
const fs = require('fs');
const path = require('path');

function localDriver(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const p = name => path.join(dir, path.basename(name));          // basename: a stored name can never escape the directory
  return {
    name: 'local',
    async put(tmpPath, name) { try { fs.renameSync(tmpPath, p(name)); } catch { fs.copyFileSync(tmpPath, p(name)); fs.rmSync(tmpPath, { force: true }); } },
    async stat(name) { try { return { size: fs.statSync(p(name)).size }; } catch { return null; } },
    read(name, range) { return fs.createReadStream(p(name), range); },
    async remove(name) { fs.rmSync(p(name), { force: true }); },
    async check() { fs.accessSync(dir, fs.constants.W_OK); },
  };
}

function gcsDriver(bucketName, { client } = {}) {
  const { Storage } = require('@google-cloud/storage');            // credentials: Application Default Credentials (Cloud Run service account)
  const bucket = (client || new Storage()).bucket(bucketName);
  return {
    name: 'gcs',
    async put(tmpPath, name, { mime } = {}) {
      await bucket.upload(tmpPath, { destination: name, resumable: false, validation: 'crc32c',
        metadata: { contentType: mime || 'application/octet-stream', cacheControl: 'private, no-store' } });
      fs.rmSync(tmpPath, { force: true });
    },
    async stat(name) { const f = bucket.file(name); const [ok] = await f.exists(); if (!ok) return null; const [m] = await f.getMetadata(); return { size: Number(m.size) }; },
    read(name, range) { return bucket.file(name).createReadStream(range ? { start: range.start, end: range.end } : undefined); },
    async remove(name) { await bucket.file(name).delete({ ignoreNotFound: true }); },
    async check() { const [ok] = await bucket.exists(); if (!ok) throw new Error(`bucket ${bucketName} not found or not accessible`); },
  };
}

function makeStorage(cfg, opts = {}) {
  return cfg.STORAGE_DRIVER === 'gcs' ? gcsDriver(cfg.GCS_BUCKET, opts) : localDriver(cfg.UPLOAD_DIR);
}
module.exports = { makeStorage, localDriver, gcsDriver };
