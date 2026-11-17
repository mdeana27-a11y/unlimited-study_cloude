// Single place that reads and validates the environment (zod). Fail fast on bad config.
require('dotenv').config({ quiet: true });
const { z } = require('zod');
const path = require('path');
const bool = z.enum(['true', 'false']).transform(v => v === 'true');

// `KEY=` lines copied from .env.example (or passed by docker env_file) mean "unset", not an empty string.
const withoutBlanks = env => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));

// Hosting platforms that put a reverse proxy in front of the app (so req.ip / rate limits / cookies need trust proxy = 1).
const PLATFORM_MARKERS = ['VERCEL', 'RENDER', 'RAILWAY_ENVIRONMENT', 'FLY_APP_NAME', 'K_SERVICE', 'DYNO', 'WEBSITE_SITE_NAME'];


function loadConfig(env = process.env) {
  env = { ...env };
  const s = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3000),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be >= 32 chars'),
    // PostgreSQL. Cloud SQL (recommended on Google): postgres://USER:PASS@/DB?host=/cloudsql/PROJECT:REGION:INSTANCE
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// connection string'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).optional(),
    DB_SSL: bool.optional(),
    STORAGE_DRIVER: z.enum(['local', 'gcs']).optional(),          // default: gcs when GCS_BUCKET is set, else local
    GCS_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,220}$/).optional(),
    ADMIN_EMAIL: z.string().email().default('mostafa@example.com'),
    ADMIN_DISPLAY_NAME: z.string().default('مصطفى المشرف التنفيذي'),
    ADMIN_PASSWORD: z.string().min(10).optional(),          // only needed by `npm run seed`
    ADMIN_TOTP_SECRET: z.string().regex(/^[A-Z2-7]+=*$/).optional(),  // base32, enables 2FA
    GOOGLE_CLIENT_ID: z.string().optional().transform(v => v || null),
    COHORT_LABEL: z.string().default('الفرقة الأولى — برنامج علوم البيانات'),
    STORAGE_DIR: z.string().default(path.join(__dirname, '..', 'storage')),
    MAX_UPLOAD_MB: z.coerce.number().positive().optional(),   // default 30 on Cloud Run (its request limit is 32 MiB), else 100
    LOG_RETENTION_MONTHS: z.coerce.number().default(12),
    TRUST_PROXY: z.coerce.number().optional(),      // auto: 1 on known hosting platforms, else 0
    COOKIE_SECURE: bool.optional(),
    RATE_LIMIT_AUTH: z.coerce.number().default(30),
    RATE_LIMIT_ADMIN: z.coerce.number().default(8),
    LOG_LEVEL: z.string().default('info'),
  }).safeParse(withoutBlanks(env));
  if (!s.success) {
    throw new Error('Invalid environment:\n' + s.error.issues.map(i => ` - ${i.path.join('.')}: ${i.message}`).join('\n')
      + '\nSet these in your hosting dashboard (Environment Variables). Required: SESSION_SECRET (32+ chars), DATABASE_URL and, on first start, ADMIN_PASSWORD (10+ chars). See docs/DEPLOY-GOOGLE.md.');
  }
  const c = s.data;
  c.cloudRun = !!env.K_SERVICE;
  c.STORAGE_DRIVER ??= c.GCS_BUCKET ? 'gcs' : 'local';
  if (c.STORAGE_DRIVER === 'gcs' && !c.GCS_BUCKET) throw new Error('Invalid environment:\n - GCS_BUCKET: required when STORAGE_DRIVER=gcs');
  if (c.cloudRun && c.STORAGE_DRIVER === 'local') throw new Error('Invalid environment:\n - STORAGE_DRIVER: Cloud Run has an ephemeral filesystem, uploads would be lost. Set GCS_BUCKET (see docs/DEPLOY-GOOGLE.md).');
  c.MAX_UPLOAD_MB ??= c.cloudRun ? 30 : 100;
  c.DB_POOL_MAX ??= 10;
  c.TRUST_PROXY ??= PLATFORM_MARKERS.some(k => env[k]) ? 1 : 0;
  c.isProd = c.NODE_ENV === 'production';
  c.cookieSecure = c.COOKIE_SECURE ?? c.isProd;
    c.UPLOAD_DIR = path.join(c.STORAGE_DIR, 'uploads');   // local driver only; outside the web root on purpose
  c.TMP_UPLOAD_DIR = path.join(require('os').tmpdir(), 'unlimited-study-uploads');   // multer staging area for every driver
  return c;
}
module.exports = { loadConfig };
