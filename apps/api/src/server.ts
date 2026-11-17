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
import { testingRoutes } from './routes/testing.js';
import { eventRoutes } from './events.js';
import { userRoutes } from './routes/users.js';
import { integrationRoutes } from './routes/integrations.js';
import { startWatchdog } from './watchdog.js';
import { stopQueue } from './queue.js';

const app = Fastify({
  logger: {
    level: env.logLevel,
    // Never write session cookies, credentials or passwords to log files.
    redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', '*.password', '*.passwordHash', '*.current', '*.next'], censor: '[hidden]' },
  },
  trustProxy: true, // behind IIS
  bodyLimit: 1_048_576,
});

// Security headers on every response (IIS adds HSTS on the HTTPS front door).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // Ant Design injects component styles at runtime
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');
app.addHook('onSend', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Content-Security-Policy', CSP);
  if (String(reply.getHeader('content-type') ?? '').includes('application/json')) reply.header('Cache-Control', 'no-store');
});

// Cross-site request guard: state-changing requests must come from MailVault's own pages.
// (The session cookie is also SameSite=Strict; this is defence in depth.)
app.addHook('onRequest', async (req, reply) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  const origin = req.headers.origin;
  if (!origin) return; // non-browser clients (scripts, tests) send no Origin
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
  try {
    const originHost = new URL(origin).host;
    const appHost = process.env.APP_URL ? new URL(process.env.APP_URL).host : null;
    if (originHost !== host && originHost !== appHost) return reply.code(403).send({ error: 'Request blocked: it did not come from MailVault' });
  } catch {
    return reply.code(403).send({ error: 'Request blocked' });
  }
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
    // Name the field and the problem, e.g. "Please check the form: Email – Enter a valid email address".
    const first = err.issues[0];
    const field = first?.path.length ? String(first.path[0]).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()) : '';
    const detail = first ? `${field ? `${field} – ` : ''}${first.message}` : '';
    return reply.code(400).send({ error: detail ? `Please check the form: ${detail}` : 'Please check the form', issues: err.issues });
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
await app.register(testingRoutes, { prefix: '/api' });
await app.register(eventRoutes, { prefix: '/api' });
await app.register(userRoutes, { prefix: '/api' });
await app.register(integrationRoutes, { prefix: '/api' });

// Production: serve the built React app and fall back to index.html for client routes.
const webDist = resolve(ROOT, 'apps/web/dist');
if (existsSync(webDist)) {
  // wildcard: serve whatever is in dist now, so a rebuild never needs an API restart to find new asset files.
  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: true,
    // Hashed files under /assets never change → cache for a year; index.html must always be fresh.
    setHeaders: (res, path) => {
      res.header('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
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

startWatchdog(app);
// Under IIS (iisnode) PORT is a named pipe such as \\.\pipe\abc; when run as a service it is a number.
const listenOn = process.env.PORT?.trim() ?? String(env.port);
if (/^\d+$/.test(listenOn)) await app.listen({ port: Number(listenOn), host: env.host });
else await app.listen({ path: listenOn });
