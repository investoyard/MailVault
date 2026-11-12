import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@mailvault/db';
import { ruleInputSchema, type RuleInput } from '@mailvault/shared';
import { requirePermission } from '../auth.js';
import { audit } from './resources.js';

const idParam = z.object({ id: z.string().min(1) });

function toData(input: RuleInput) {
  return {
    name: input.name,
    description: input.description || null,
    mailboxId: input.mailboxId,
    enabled: input.enabled,
    priority: input.priority,
    stopFurtherRules: input.stopFurtherRules,
    simulationMode: input.simulationMode,
    conditions: input.conditions,
    attachments: input.attachments,
    destinationId: input.download.destinationId,
    download: input.download,
    duplicatePolicy: input.download.duplicatePolicy,
    autoDownload: input.download.autoDownload,
  };
}

export async function ruleRoutes(app: FastifyInstance) {
  app.get('/rules/:id', { preHandler: requirePermission('rules') }, async (req) => {
    const { id } = idParam.parse(req.params);
    return prisma.rule.findUniqueOrThrow({
      where: { id },
      include: { mailbox: { select: { email: true } }, versions: { orderBy: { version: 'desc' }, take: 20, select: { version: true, createdAt: true, changedById: true } } },
    });
  });

  app.post('/rules', { preHandler: requirePermission('rules', 'create') }, async (req, reply) => {
    const input = ruleInputSchema.parse(req.body);
    const clash = await prisma.rule.findFirst({ where: { mailboxId: input.mailboxId, name: input.name } });
    if (clash) return reply.code(409).send({ error: 'A rule with this name already exists for this mailbox' });

    const rule = await prisma.$transaction(async (tx) => {
      const r = await tx.rule.create({ data: { ...toData(input), createdById: req.user.id, currentVersion: 1 } });
      await tx.ruleVersion.create({ data: { ruleId: r.id, version: 1, snapshot: input as never, changedById: req.user.id } });
      return r;
    });
    await audit(req.user.id, 'RULE_CREATED', 'Rule', rule.id, null, input, req.ip);
    return rule;
  });

  // Edits create a new version; emails already processed keep the version they matched (traceability).
  app.put('/rules/:id', { preHandler: requirePermission('rules', 'edit') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const input = ruleInputSchema.parse(req.body);
    const before = await prisma.rule.findUniqueOrThrow({ where: { id } });
    const clash = await prisma.rule.findFirst({ where: { mailboxId: input.mailboxId, name: input.name, id: { not: id } } });
    if (clash) return reply.code(409).send({ error: 'A rule with this name already exists for this mailbox' });

    const version = before.currentVersion + 1;
    const rule = await prisma.$transaction(async (tx) => {
      const r = await tx.rule.update({ where: { id }, data: { ...toData(input), currentVersion: version } });
      await tx.ruleVersion.create({ data: { ruleId: id, version, snapshot: input as never, changedById: req.user.id } });
      return r;
    });
    const { createdAt: _c, updatedAt: _u, ...beforeFields } = before;
    await audit(req.user.id, 'RULE_UPDATED', 'Rule', id, beforeFields, { ...input, version }, req.ip);
    return rule;
  });
}
