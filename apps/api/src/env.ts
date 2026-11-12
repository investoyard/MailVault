// Loaded first by server.ts so every later import sees the root .env.
import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
config({ path: resolve(ROOT, '.env'), quiet: true });

// Prisma returns BigInt for some columns; let JSON responses carry them as numbers.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is missing in .env (run: npm run gen-keys)`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 3200),
  host: process.env.HOST ?? '127.0.0.1',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  jwtSecret: (() => {
    const s = required('JWT_SECRET');
    if (s.length < 32) throw new Error('JWT_SECRET is too short (min 32 characters). Run: npm run gen-keys');
    return s;
  })(),
  timeZone: process.env.BUSINESS_TIMEZONE ?? 'Asia/Kolkata',
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
