import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WEBHOOK_EVENTS, deliverOne, encryptSecret, newWebhookSecret, prisma } from '@mailvault/db';
import { requirePermission } from '../auth.js';
import { audit } from './resources.js';

const idParam = z.object({ id: z.string().min(1) });
const webhookInput = z.object({
  name: z.string().trim().min(2).max(80),
  url: z
    .url()
    .trim()
    .refine((u) => /^https?:\/\//i.test(u), 'Use an http:// or https:// address'),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Choose at least one event'),
  mailboxIds: z.array(z.string()).default([]),
  ruleIds: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

const publicFields = {
  id: true,
  name: true,
  url: true,
  events: true,
  mailboxIds: true,
  ruleIds: true,
  enabled: true,
  lastStatus: true,
  lastError: true,
  lastDeliveredAt: true,
  createdAt: true,
} as const;

export async function integrationRoutes(app: FastifyInstance) {
  app.get('/webhooks', { preHandler: requirePermission('settings') }, async () => {
    const hooks = await prisma.webhook.findMany({ orderBy: { createdAt: 'asc' }, select: publicFields });
    const since = new Date(Date.now() - 24 * 3600_000);
    const stats = await prisma.webhookDelivery.groupBy({ by: ['webhookId', 'status'], where: { createdAt: { gte: since } }, _count: { _all: true } });
    return hooks.map((h) => {
      const s = (status: string) => stats.filter((x) => x.webhookId === h.id && x.status === status).reduce((a, x) => a + x._count._all, 0);
      return { ...h, last24h: { success: s('SUCCESS'), failed: s('FAILED'), pending: s('PENDING') + s('RETRYING') + s('SENDING') } };
    });
  });

  // The signing secret is shown once, when created or rotated.
  app.post('/webhooks', { preHandler: requirePermission('settings', 'edit') }, async (req) => {
    const input = webhookInput.parse(req.body);
    const secret = newWebhookSecret();
    const hook = await prisma.webhook.create({ data: { ...input, secretEnc: encryptSecret(secret) }, select: publicFields });
    await audit(req.user.id, 'WEBHOOK_CREATED', 'Webhook', hook.id, null, input, req.ip);
    return { webhook: hook, secret };
  });

  app.put('/webhooks/:id', { preHandler: requirePermission('settings', 'edit') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = webhookInput.parse(req.body);
    const before = await prisma.webhook.findUniqueOrThrow({ where: { id }, select: publicFields });
    const hook = await prisma.webhook.update({ where: { id }, data: input, select: publicFields });
    await audit(req.user.id, 'WEBHOOK_UPDATED', 'Webhook', id, before, input, req.ip);
    return hook;
  });

  app.delete('/webhooks/:id', { preHandler: requirePermission('settings', 'edit') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const before = await prisma.webhook.findUniqueOrThrow({ where: { id }, select: publicFields });
    await prisma.webhook.delete({ where: { id } });
    await audit(req.user.id, 'WEBHOOK_DELETED', 'Webhook', id, before, null, req.ip);
    return { ok: true };
  });

  app.post('/webhooks/:id/rotate-secret', { preHandler: requirePermission('settings', 'edit') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const secret = newWebhookSecret();
    await prisma.webhook.update({ where: { id }, data: { secretEnc: encryptSecret(secret) } });
    await audit(req.user.id, 'WEBHOOK_SECRET_ROTATED', 'Webhook', id, null, null, req.ip);
    return { secret };
  });

  // Sends a "ping" right away and reports what the receiving system answered.
  app.post('/webhooks/:id/test', { preHandler: requirePermission('settings', 'execute') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const d = await prisma.webhookDelivery.create({
      data: { webhookId: id, event: 'ping', status: 'SENDING', payload: { event: 'ping', occurredAt: new Date().toISOString(), data: { message: 'Test from MailVault', by: req.user.username } } },
    });
    const r = await deliverOne(d.id);
    await audit(req.user.id, 'WEBHOOK_TESTED', 'Webhook', id, null, r, req.ip);
    return r.ok ? { ok: true, message: `Delivered: the receiver answered HTTP ${r.status}.` } : { ok: false, message: `Not delivered: ${r.error}` };
  });

  app.get('/webhooks/:id/deliveries', { preHandler: requirePermission('settings') }, async (req) => {
    const { id } = idParam.parse(req.params);
    return prisma.webhookDelivery.findMany({ where: { webhookId: id }, orderBy: { createdAt: 'desc' }, take: 100 });
  });

  app.post('/webhook-deliveries/:id/redeliver', { preHandler: requirePermission('settings', 'execute') }, async (req) => {
    const { id } = idParam.parse(req.params);
    await prisma.webhookDelivery.update({ where: { id }, data: { status: 'SENDING', attempts: 0, nextAttemptAt: null } });
    const r = await deliverOne(id);
    await audit(req.user.id, 'WEBHOOK_REDELIVERED', 'WebhookDelivery', id, null, r, req.ip);
    return r.ok ? { ok: true, message: `Delivered (HTTP ${r.status}).` } : { ok: false, message: `Not delivered: ${r.error}. It will be retried automatically.` };
  });
}
