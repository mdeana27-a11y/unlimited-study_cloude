import { afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
afterAll(async () => { await require('./helpers').closeAll(); });     // close pools / listeners / drop this file's databases
