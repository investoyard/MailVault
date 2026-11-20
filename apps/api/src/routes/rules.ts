import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { encryptSecret, prisma } from '@mailvault/db';
import { rulePasswordsSchema, ruleInputSchema, type RuleInput } from '@mailvault/shared';
import { assertMailbox, requirePermission } from '../auth.js';
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

/**
 * File passwords sent with a rule: undefined = keep, [] = remove, list = replace.
 * Stored encrypted on the rule only (not in the rule JSON, versions or audit log).
 */
function passwordData(body: unknown) {
  const { filePasswords } = rulePasswordsSchema.parse(body);
  if (filePasswords === undefined) return { data: {}, audit: 'unchanged' };
  const list = [...new Set(filePasswords)];
  return {
    data: { filePasswords: list.length ? encryptSecret(JSON.stringify(list)) : null, filePasswordCount: list.length },
    audit: list.length ? `${list.length} set` : 'removed',
  };
}

/** Never send the encrypted passwords to the browser. */
const OMIT = { filePasswords: true } as const;

export async function ruleRoutes(app: FastifyInstance) {
  app.get('/rules/:id', { preHandler: requirePermission('rules') }, async (req) => {
    const { id } = idParam.parse(req.params);
    assertMailbox(req, (await prisma.rule.findUniqueOrThrow({ where: { id } })).mailboxId);
    return prisma.rule.findUniqueOrThrow({
      where: { id },
      omit: OMIT,
      include: { mailbox: { select: { email: true } }, versions: { orderBy: { version: 'desc' }, take: 20, select: { version: true, createdAt: true, changedById: true } } },
    });
  });

  app.post('/rules', { preHandler: requirePermission('rules', 'create') }, async (req, reply) => {
    const input = ruleInputSchema.parse(req.body);
    const pw = passwordData(req.body);
    assertMailbox(req, input.mailboxId);
    const clash = await prisma.rule.findFirst({ where: { mailboxId: input.mailboxId, name: input.name } });
    if (clash) return reply.code(409).send({ error: 'A rule with this name already exists for this mailbox' });

    const rule = await prisma.$transaction(async (tx) => {
      const r = await tx.rule.create({ data: { ...toData(input), ...pw.data, createdById: req.user.id, currentVersion: 1 }, omit: OMIT });
      await tx.ruleVersion.create({ data: { ruleId: r.id, version: 1, snapshot: input as never, changedById: req.user.id } });
      return r;
    });
    await audit(req.user.id, 'RULE_CREATED', 'Rule', rule.id, null, { ...input, filePasswords: pw.audit }, req.ip);
    return rule;
  });

  // Edits create a new version; emails already processed keep the version they matched (traceability).
  app.put('/rules/:id', { preHandler: requirePermission('rules', 'edit') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const input = ruleInputSchema.parse(req.body);
    const pw = passwordData(req.body);
    const before = await prisma.rule.findUniqueOrThrow({ where: { id }, omit: OMIT });
    assertMailbox(req, before.mailboxId);
    assertMailbox(req, input.mailboxId);
    const clash = await prisma.rule.findFirst({ where: { mailboxId: input.mailboxId, name: input.name, id: { not: id } } });
    if (clash) return reply.code(409).send({ error: 'A rule with this name already exists for this mailbox' });

    const version = before.currentVersion + 1;
    const rule = await prisma.$transaction(async (tx) => {
      const r = await tx.rule.update({ where: { id }, data: { ...toData(input), ...pw.data, currentVersion: version }, omit: OMIT });
      await tx.ruleVersion.create({ data: { ruleId: id, version, snapshot: input as never, changedById: req.user.id } });
      return r;
    });
    const { createdAt: _c, updatedAt: _u, ...beforeFields } = before;
    await audit(req.user.id, 'RULE_UPDATED', 'Rule', id, beforeFields, { ...input, version, filePasswords: pw.audit }, req.ip);
    return rule;
  });
}
