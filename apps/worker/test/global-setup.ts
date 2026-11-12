import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

export default function setup() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('/mailvault_test')) throw new Error('Refusing to run integration tests outside mailvault_test');
  // Creates the database if missing and applies all migrations.
  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '../../../packages/db'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
