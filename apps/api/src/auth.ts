import type { FastifyReply, FastifyRequest } from 'fastify';
import { ROLE_TEMPLATES, can, type Action, type Module, type PermissionSet, type Role } from '@mailvault/shared';

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

export const COOKIE_NAME = 'mv_session';

export function permissionsFor(role: Role, overrides?: unknown): PermissionSet {
  return { ...ROLE_TEMPLATES[role], ...((overrides as PermissionSet | null) ?? {}) };
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify({ onlyCookie: true });
  } catch {
    return reply.code(401).send({ error: 'Please sign in' });
  }
}

/** Route guard: checks the module × action matrix on the server (never only in the UI). */
export function requirePermission(module: Module, action: Action = 'view') {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    if (!can(permissionsFor(req.user.role), module, action)) {
      return reply.code(403).send({ error: 'You do not have permission for this action' });
    }
  };
}
