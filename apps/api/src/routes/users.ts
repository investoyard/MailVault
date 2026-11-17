import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@mailvault/db';
import { ACTIONS, MODULES, ROLES } from '@mailvault/shared';
import { invalidateAccess, requireAuth, requirePermission } from '../auth.js';
import { audit } from './resources.js';

const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .refine((p) => /[a-zA-Z]/.test(p) && /\d/.test(p), 'Use letters and numbers');

// partialRecord: a permission set lists only the modules it grants (zod 4's z.record with an enum key
// would demand every module).
const permissionsSchema = z.partialRecord(z.enum(MODULES), z.array(z.enum(ACTIONS))).nullable().optional();

const userBase = {
  displayName: z.string().trim().min(2, 'Enter the full name (at least 2 characters)').max(120),
  // Optional; blank/null means "no email". Trimmed before the format check so a stray space is fine.
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.union([z.literal(''), z.email('Enter a valid email address')]))
    .nullish()
    .transform((e) => e || undefined),
  role: z.enum(ROLES),
  mailboxIds: z.array(z.string()).nullish().transform((ids) => ids ?? []),
  permissions: permissionsSchema,
};

const safeUser = {
  id: true,
  username: true,
  email: true,
  displayName: true,
  role: true,
  permissions: true,
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
  entraObjectId: true,
  mailboxAccess: { select: { mailboxId: true } },
} as const;

async function activeSuperAdmins(excludeId?: string) {
  return prisma.user.count({ where: { role: 'SUPER_ADMIN', isActive: true, id: excludeId ? { not: excludeId } : undefined } });
}

export async function userRoutes(app: FastifyInstance) {
  app.get('/users', { preHandler: requirePermission('users') }, async () => {
    const users = await prisma.user.findMany({ orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }], select: safeUser });
    return users.map(({ mailboxAccess, ...u }) => ({ ...u, mailboxIds: mailboxAccess.map((m) => m.mailboxId) }));
  });

  app.post('/users', { preHandler: requirePermission('users', 'create') }, async (req, reply) => {
    const b = z.object({ username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, '3–40 letters, numbers, dot, dash or underscore'), password, ...userBase }).parse(req.body);
    if (b.role === 'SUPER_ADMIN' && req.access.role !== 'SUPER_ADMIN') return reply.code(403).send({ error: 'Only a Super Admin can create another Super Admin' });
    if (await prisma.user.findUnique({ where: { username: b.username } })) return reply.code(409).send({ error: 'This username is already taken' });
    if (b.email && (await prisma.user.findUnique({ where: { email: b.email } }))) return reply.code(409).send({ error: 'This email is already used by another user' });

    const user = await prisma.user.create({
      data: {
        username: b.username,
        displayName: b.displayName,
        email: b.email,
        role: b.role,
        permissions: b.role === 'SUPER_ADMIN' ? undefined : (b.permissions ?? undefined),
        passwordHash: await bcrypt.hash(b.password, 12),
        mustChangePassword: true, // the person sets their own password at first sign-in
        mailboxAccess: b.role === 'SUPER_ADMIN' ? undefined : { create: b.mailboxIds.map((mailboxId) => ({ mailboxId })) },
      },
      select: { id: true, username: true },
    });
    await audit(req.user.id, 'USER_CREATED', 'User', user.id, null, { ...b, password: undefined }, req.ip);
    return user;
  });

  app.put('/users/:id', { preHandler: requirePermission('users', 'edit') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ ...userBase, isActive: z.boolean() }).parse(req.body);
    const before = await prisma.user.findUniqueOrThrow({ where: { id }, include: { mailboxAccess: true } });

    if ((b.role === 'SUPER_ADMIN' || before.role === 'SUPER_ADMIN') && req.access.role !== 'SUPER_ADMIN') {
      return reply.code(403).send({ error: 'Only a Super Admin can change Super Admin accounts' });
    }
    if (id === req.user.id && (!b.isActive || b.role !== before.role)) {
      return reply.code(400).send({ error: 'You cannot disable your own account or change your own role' });
    }
    if (before.role === 'SUPER_ADMIN' && (b.role !== 'SUPER_ADMIN' || !b.isActive) && (await activeSuperAdmins(id)) === 0) {
      return reply.code(400).send({ error: 'MailVault needs at least one active Super Admin' });
    }
    if (b.email && (await prisma.user.findFirst({ where: { email: b.email, id: { not: id } } }))) return reply.code(409).send({ error: 'This email is already used by another user' });

    await prisma.$transaction([
      prisma.user.update({
        where: { id },
        data: {
          displayName: b.displayName,
          email: b.email ?? null,
          role: b.role,
          isActive: b.isActive,
          permissions: b.role === 'SUPER_ADMIN' || !b.permissions ? undefined : b.permissions,
        },
      }),
      ...(b.role !== 'SUPER_ADMIN' && !b.permissions ? [prisma.$executeRaw`UPDATE "User" SET permissions = NULL WHERE id = ${id}`] : []),
      prisma.userMailboxAccess.deleteMany({ where: { userId: id } }),
      ...(b.role === 'SUPER_ADMIN' ? [] : [prisma.userMailboxAccess.createMany({ data: b.mailboxIds.map((mailboxId) => ({ userId: id, mailboxId })) })]),
    ]);
    invalidateAccess(id);
    await audit(
      req.user.id,
      before.isActive && !b.isActive ? 'USER_DISABLED' : 'USER_UPDATED',
      'User',
      id,
      { displayName: before.displayName, email: before.email, role: before.role, isActive: before.isActive, permissions: before.permissions, mailboxIds: before.mailboxAccess.map((m) => m.mailboxId) },
      b,
      req.ip,
    );
    return { ok: true };
  });

  app.post('/users/:id/reset-password', { preHandler: requirePermission('users', 'edit') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { password: pw } = z.object({ password }).parse(req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    if (u.role === 'SUPER_ADMIN' && req.access.role !== 'SUPER_ADMIN') return reply.code(403).send({ error: 'Only a Super Admin can reset a Super Admin password' });
    await prisma.user.update({ where: { id }, data: { passwordHash: await bcrypt.hash(pw, 12), mustChangePassword: id !== req.user.id } });
    await audit(req.user.id, 'USER_PASSWORD_RESET', 'User', id, null, null, req.ip);
    return { ok: true, message: `Password reset. ${u.displayName} must choose a new one at next sign-in.` };
  });

  // Self-service
  app.post('/auth/change-password', { preHandler: requireAuth }, async (req, reply) => {
    const b = z.object({ current: z.string().min(1), next: password }).parse(req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id } });
    if (!u.passwordHash || !(await bcrypt.compare(b.current, u.passwordHash))) return reply.code(400).send({ error: 'Your current password is not correct' });
    if (b.current === b.next) return reply.code(400).send({ error: 'Choose a password different from the current one' });
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(b.next, 12), mustChangePassword: false } });
    await audit(u.id, 'PASSWORD_CHANGED', 'User', u.id, null, null, req.ip);
    return { ok: true };
  });

  app.get('/me/preferences', { preHandler: requireAuth }, async (req) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { email: true, notificationPrefs: true } });
    return { email: u.email, prefs: { email: true, digest: 'instant', minSeverity: 'WARNING', ...((u.notificationPrefs as object | null) ?? {}) } };
  });

  app.put('/me/preferences', { preHandler: requireAuth }, async (req) => {
    const prefs = z
      .object({ email: z.boolean(), digest: z.enum(['instant', 'daily', 'off']), minSeverity: z.enum(['INFO', 'WARNING', 'ERROR']) })
      .parse(req.body);
    await prisma.user.update({ where: { id: req.user.id }, data: { notificationPrefs: prefs } });
    await audit(req.user.id, 'PREFERENCES_UPDATED', 'User', req.user.id, null, prefs, req.ip);
    return { ok: true };
  });
}
