import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  // Prisma 7 talks to PostgreSQL through the node-postgres driver adapter.
  const url = process.env.DATABASE_URL ?? '';
  const schema = /[?&]schema=([^&]+)/.exec(url)?.[1] ?? 'public';
  const adapter = new PrismaPg({ connectionString: url.replace(/\?.*$/, ''), max: 10 }, { schema });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createClient();
globalForPrisma.prisma = prisma;
export * from './ops.js';
export * from './secrets.js';
export * from './webhooks.js';
