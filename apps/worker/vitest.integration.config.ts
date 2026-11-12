// Integration tests run against a separate database "mailvault_test" (created/migrated automatically).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const envFile = readFileSync(resolve(__dirname, '../../.env'), 'utf8');
const dbUrl = /^DATABASE_URL="?([^"\r\n]+)"?/m.exec(envFile)?.[1];
if (!dbUrl) throw new Error('DATABASE_URL missing in .env');
const testUrl = dbUrl.replace(/\/mailvault(\?|$)/, '/mailvault_test$1');
process.env.DATABASE_URL = testUrl; // for globalSetup (runs in this process)

export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    env: { DATABASE_URL: testUrl, LOG_LEVEL: 'silent', M365_TENANT_ID: '', M365_CLIENT_ID: '' },
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
