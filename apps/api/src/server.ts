import { ROOT, env } from './env.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { prisma } from '@mailvault/db';
import { COOKIE_NAME } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { resourceRoutes } from './routes/resources.js';
import { adminRoutes } from './routes/admin.js';
import { ruleRoutes } from './routes/rules.js';
import { stopQueue } from './queue.js';

const app = Fastify({
  logger: { level: env.logLevel },
  trustProxy: true, // behind IIS
});

await app.register(cookie);
await app.register(jwt, {
  secret: env.jwtSecret,
  cookie: { cookieName: COOKIE_NAME, signed: false },
  sign: { expiresIn: '10h' },
});

app.setErrorHandler((err, req, reply) => {
  if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Not found' });
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: 'Please check the form', issues: err.issues });
  }
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) req.log.error(err);
  return reply.code(status).send({ error: status >= 500 ? 'Something went wrong on the server' : (err as Error).message });
});

app.get('/api/health', async () => {
  await prisma.$queryRaw`SELECT 1`;
  return { ok: true, service: 'mailvault-api', time: new Date().toISOString() };
});

await app.register(authRoutes, { prefix: '/api/auth' });
await app.register(dashboardRoutes, { prefix: '/api/dashboard' });
await app.register(resourceRoutes, { prefix: '/api' });
await app.register(adminRoutes, { prefix: '/api' });
await app.register(ruleRoutes, { prefix: '/api' });

// Production: serve the built React app and fall back to index.html for client routes.
const webDist = resolve(ROOT, 'apps/web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}

const shutdown = async () => {
  await app.close();
  await stopQueue();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: env.port, host: env.host });
