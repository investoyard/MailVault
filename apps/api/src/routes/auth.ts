import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { prisma } from '@mailvault/db';
import { loginSchema } from '@mailvault/shared';
import { env } from '../env.js';
import { COOKIE_NAME, permissionsFor, requireAuth, type SessionUser } from '../auth.js';

// Simple brute-force guard: 8 failed attempts per IP+username locks for 15 minutes.
const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60 * 1000;

export async function authRoutes(app: FastifyInstance) {
  // Local sign-in (break-glass admin + Phase 0). Entra ID SSO is added in Phase 1.
  app.post('/login', async (req, reply) => {
    const { username, password } = loginSchema.parse(req.body);
    const key = `${req.ip}|${username.toLowerCase()}`;
    const f = failures.get(key);
    if (f && f.count >= MAX_FAILS && f.until > Date.now()) {
      return reply.code(429).send({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    }
    const user = await prisma.user.findUnique({ where: { username: username.toLowerCase() } });
    const ok = user?.isActive && user.passwordHash && (await bcrypt.compare(password, user.passwordHash));

    await prisma.auditLog.create({
      data: {
        userId: ok ? user!.id : null,
        action: ok ? 'LOGIN' : 'LOGIN_FAILED',
        entityType: 'User',
        after: { username },
        ip: req.ip,
      },
    });
    if (!ok || !user) {
      const count = (f && f.until > Date.now() ? f.count : 0) + 1;
      failures.set(key, { count, until: Date.now() + LOCK_MS });
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    failures.delete(key);

    const session: SessionUser = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    };
    const token = await reply.jwtSign(session);
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    reply.setCookie(COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: env.cookieSecure,
      maxAge: 10 * 60 * 60,
    });
    return { user: session, permissions: permissionsFor(user.role, user.permissions) };
  });

  app.post('/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  app.get('/me', { preHandler: requireAuth }, async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    return { user: req.user, permissions: permissionsFor(req.user.role, user?.permissions) };
  });
}
