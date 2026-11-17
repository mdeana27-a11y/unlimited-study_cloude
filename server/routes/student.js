const express = require('express');
const { z } = require('zod');

// One byte range ("bytes=START-END"), enough for <video> seeking. Returns null for none, 'bad' for unsatisfiable.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || ''); if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { const n = +m[2]; if (!n) return 'bad'; start = Math.max(size - n, 0); end = size - 1; }
  else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); }
  return start > end || start >= size ? 'bad' : { start, end };
}

module.exports = function studentRoutes({ cfg, repo, mw, storage }) {
  const r = express.Router();
  // /me is public on purpose: anonymous -> { user: null } (200) so the SPA boots without a console error.
  r.get('/me', (req, res) => res.json({ user: req.user && { type: req.user.type, name: req.user.name, code: req.user.code, email: req.user.email, hall: req.user.hall } }));
  r.use(mw.requireAuth);                       // admins may browse too; everything below is read-only
  r.get('/subjects', async (req, res) => res.json({ subjects: await repo.subjects(req.user.type === 'student' ? req.user.id : -1) }));
  r.get('/announcements', async (_q, res) => res.json({ announcements: await repo.announcements() }));

  r.get('/subjects/:slug', mw.validate(z.object({ slug: z.string().regex(/^[a-z0-9-]{1,60}$/) }), 'params'), async (req, res) => {
    const s = await repo.subjectBySlug(req.params.slug);
    if (!s) return res.status(404).json({ error: 'not_found' });
    const since = req.user.type === 'student' ? await repo.lastVisit(req.user.id, s.id) : null;
    const [files, lectures, sections, tasks] = await Promise.all([repo.filesOfSubject(s.id), repo.content('lectures', s.id),
      s.has_sections ? repo.content('sections', s.id) : [], s.has_tasks ? repo.content('tasks', s.id) : []]);
    const isNew = ts => since ? ts > since : req.user.type === 'student';   // first visit: everything is new (same rule everywhere)
    const withFiles = (kind, rows) => rows.map(x => ({ ...x, is_new: isNew(x.created_at),
      files: files.filter(f => f.owner_kind === kind && f.owner_id === x.id) }));
    if (req.user.type === 'student') await repo.markVisit(req.user.id, s.id);
    await mw.logEvent(req, { event: 'view_subject', meta: { subject: s.slug } });
    res.json({
      subject: s, lectures: withFiles('lecture', lectures), sections: withFiles('section', sections), tasks: withFiles('task', tasks),
      materials: files.filter(f => f.owner_kind === 'subject').map(f => ({ ...f, is_new: isNew(f.uploaded_at) })),
    });
  });

  // Files are never public: auth first, then a DB lookup — the client never supplies a path or a bucket object name.
  r.get('/files/:id', mw.validate(z.object({ id: z.coerce.number().int().positive() }), 'params'), async (req, res) => {
    const f = await repo.file(req.params.id);
    if (!f || !/^[a-f0-9]{32}\.[a-z0-9]{1,8}$/.test(f.stored_name)) return res.status(404).json({ error: 'not_found' });
    const st = await storage.stat(f.stored_name);
    if (!st) return res.status(404).json({ error: 'not_found' });
    await mw.logEvent(req, { event: 'download_file', path: `/files/${f.id}`, meta: { fileId: f.id, name: f.original_name, subject: await repo.fileSubjectSlug(f) } });
    const range = parseRange(req.headers.range, st.size);
    if (range === 'bad') return res.status(416).set('Content-Range', `bytes */${st.size}`).end();
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' });
    res.attachment(f.original_name);                       // Content-Disposition (RFC 6266, unicode-safe) + Content-Type from the extension
    if (range) res.status(206).set({ 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`, 'Content-Length': range.end - range.start + 1 });
    else res.set('Content-Length', st.size);
    const stream = storage.read(f.stored_name, range || undefined);
    stream.on('error', err => { req.log?.error({ err: err.message }, 'file stream failed'); res.destroy(err); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  return r;
};
