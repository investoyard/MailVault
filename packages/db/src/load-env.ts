// Loads the repository .env for scripts run directly (seed, seed-demo). Existing env vars win.
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });
