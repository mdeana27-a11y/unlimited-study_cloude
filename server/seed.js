// Idempotent seeding: re-running never duplicates rows or overwrites supervisor edits.
const fs = require('fs');
const path = require('path');
const argon2 = require('argon2');
const { parse } = require('csv-parse/sync');
const { normalizeArabic } = require('./lib/arabic');

const SUBJECTS = [
  ['expert-systems', 'النظم الخبيرة', 'Expert Systems', 'د. عبد السلام حلمي', 'م. زينب', true, true, '#8B5CF6', 'brain'],
  ['data-engineering', 'هندسة وتحليل البيانات', 'Data Engineering and Analysis', 'د. هند ذياده', 'م. محمد إبراهيم', true, true, '#22D3EE', 'database'],
  ['artificial-intelligence', 'الذكاء الاصطناعي', 'Artificial Intelligence', 'د. نجلاء سعيد', 'م. عمر جمعة', true, true, '#60A5FA', 'cpu'],
  ['web-applications', 'تطبيقات الويب', 'Web Applications', 'د. شريف', 'غير محدد', true, true, '#34D399', 'globe'],
  ['ds-fundamentals', 'أساسيات علم البيانات', 'Data Science Fundamentals', 'د. شريف', 'م. آية ندى و م. رضوى (معاً)', true, true, '#E879F9', 'chart'],
  ['history-of-technology', 'تاريخ التكنولوجيا', 'History of Technology', 'د. شريف', 'لا يوجد', false, false, '#FBBF24', 'clock'],
  ['health-safety', 'الصحة والسلامة', 'Health and Safety', 'غير محدد', 'لا يوجد', false, false, '#FB7185', 'shield'],
  ['subject-8', 'المادة الثامنة — قريباً', 'Eighth subject — coming soon', '—', '—', true, true, '#94A3B8', 'sparkles'],
];

async function seedAll(db, cfg, { csvPath = path.join(__dirname, '..', 'data', 'students.csv'), log = console.log } = {}) {
  const rows = parse(fs.readFileSync(csvPath, 'utf8'), { columns: true, bom: true, skip_empty_lines: true });
  let adminHash = null;
  if (!(await db.one('SELECT 1 AS x FROM admins WHERE email=?', [cfg.ADMIN_EMAIL]))) {
    if (!cfg.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD (>=10 chars) must be set for the first start');
    adminHash = await argon2.hash(cfg.ADMIN_PASSWORD, { type: argon2.argon2id });
  }
  let adminCreated = false;
  await db.tx(async t => {
    // One bulk upsert for the whole roster. email / is_active / created_at are never touched on re-seed.
    await t.query(`INSERT INTO students (code,name,name_normalized,name_raw,hall,seq)
      SELECT * FROM unnest(?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::int[])
      ON CONFLICT (code) DO UPDATE SET name=excluded.name, name_normalized=excluded.name_normalized, name_raw=excluded.name_raw, hall=excluded.hall, seq=excluded.seq`,
    [rows.map(r => r.code), rows.map(r => r.name), rows.map(r => normalizeArabic(r.name)), rows.map(r => r.name_raw || null),
      rows.map(r => (r.hall === 'None' || !r.hall ? null : r.hall)), rows.map(r => (r.seq ? +r.seq : null))]);
    for (const [i, s] of SUBJECTS.entries())                       // DO NOTHING: keeps the supervisor's edits
      await t.query(`INSERT INTO subjects (slug,title_ar,title_en,doctor_name,ta_names,has_sections,has_tasks,color,icon,sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (slug) DO NOTHING`, [...s, i]);
    if (adminHash) {
      adminCreated = (await t.query(`INSERT INTO admins (display_name,email,password_hash,totp_secret) VALUES (?,?,?,?) ON CONFLICT (email) DO NOTHING`,
        [cfg.ADMIN_DISPLAY_NAME, cfg.ADMIN_EMAIL, adminHash, cfg.ADMIN_TOTP_SECRET || null])).rowCount === 1;
    }
  });
  const out = { students: await db.val('SELECT COUNT(*) FROM students'), subjects: await db.val('SELECT COUNT(*) FROM subjects'), adminCreated };
  log(`seed: ${out.students} students, ${out.subjects} subjects, admin ${adminCreated ? 'created' : 'already exists'}`);
  return out;
}
module.exports = { seedAll, SUBJECTS };
