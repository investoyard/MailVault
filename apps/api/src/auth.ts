import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '@mailvault/db';
import { ROLE_TEMPLATES, can, isAdminRole, type Action, type Module, type PermissionSet, type Role } from '@mailvault/shared';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: SessionUser;
    user: SessionUser;
  }
}

export interface AccessInfo {
  role: Role;
  permissions: PermissionSet;
  /** null = every mailbox (Super Admin); otherwise only these mailbox IDs. */
  mailboxIds: string[] | null;
  isActive: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    access: AccessInfo;
  }
}

export const COOKIE_NAME = 'mv_session';

export function permissionsFor(role: Role, overrides?: unknown): PermissionSet {
  if (role === 'SUPER_ADMIN') return ROLE_TEMPLATES.SUPER_ADMIN; // never restrictable, to avoid lock-out
  return { ...ROLE_TEMPLATES[role], ...((overrides as PermissionSet | null) ?? {}) };
}

// Access is read from the database (not the token), so role changes, mailbox assignments and
// disabled accounts apply within seconds, without waiting for the user to sign in again.
const cache = new Map<string, { at: number; info: AccessInfo }>();
const TTL_MS = 10_000;

export async function loadAccess(userId: string): Promise<AccessInfo | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;
  const u = await prisma.user.findUnique({ where: { id: userId }, include: { mailboxAccess: { select: { mailboxId: true } } } });
  if (!u) return null;
  const info: AccessInfo = {
    role: u.role,
    permissions: permissionsFor(u.role, u.permissions),
    mailboxIds: u.role === 'SUPER_ADMIN' ? null : u.mailboxAccess.map((m) => m.mailboxId),
    isActive: u.isActive,
  };
  cache.set(userId, { at: Date.now(), info });
  return info;
}

export function invalidateAccess(userId?: string) {
  if (userId) cache.delete(userId);
  else cache.clear();
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify({ onlyCookie: true });
  } catch {
    return reply.code(401).send({ error: 'Please sign in' });
  }
  const access = await loadAccess(req.user.id);
  if (!access || !access.isActive) {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.code(401).send({ error: 'Your account is disabled. Contact an administrator.' });
  }
  req.access = access;
}

/** Route guard: checks the module × action matrix on the server (never only in the UI). */
export function requirePermission(module: Module, action: Action = 'view') {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    if (!can(req.access.permissions, module, action)) {
      return reply.code(403).send({ error: 'You do not have permission for this action' });
    }
  };
}

/** Like requirePermission, but also only for Admin / Super Admin (permission overrides can't widen it). */
export function requireAdminPermission(module: Module, action: Action) {
  const check = requirePermission(module, action);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await check(req, reply);
    if (reply.sent) return;
    if (!isAdminRole(req.access.role)) {
      return reply.code(403).send({ error: 'Only administrators can do this' });
    }
  };
}

/**
 * Mailboxes the current user may see, optionally narrowed to one selected mailbox.
 * Returns undefined for "no restriction" (Super Admin, nothing selected).
 */
export function mailboxScope(req: FastifyRequest, selected?: string | null): string[] | undefined {
  const allowed = req.access.mailboxIds;
  if (selected) return allowed === null || allowed.includes(selected) ? [selected] : [];
  return allowed === null ? undefined : allowed;
}

export function canSeeMailbox(req: FastifyRequest, mailboxId: string): boolean {
  return req.access.mailboxIds === null || req.access.mailboxIds.includes(mailboxId);
}

/** Throws a 404-style error when the user may not access the mailbox (does not reveal that it exists). */
export function assertMailbox(req: FastifyRequest, mailboxId: string) {
  if (!canSeeMailbox(req, mailboxId)) throw Object.assign(new Error('Not found'), { statusCode: 404 });
}
