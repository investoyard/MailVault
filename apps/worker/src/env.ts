import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
config({ path: resolve(ROOT, '.env'), quiet: true });

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  heartbeatSeconds: Number(process.env.WORKER_HEARTBEAT_SECONDS ?? 30),
  timeZone: process.env.BUSINESS_TIMEZONE ?? 'Asia/Kolkata',
};

export const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'mailvault-worker' } });
