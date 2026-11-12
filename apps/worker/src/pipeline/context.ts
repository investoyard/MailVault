import type { MailProvider } from '@mailvault/core';
import { prisma } from '@mailvault/db';
import { M365Provider, graphConfigFromEnv } from '@mailvault/m365';
import { DEFAULT_BLOCKED_EXTENSIONS } from '@mailvault/shared';

export interface PipelineSettings {
  syncIntervalMinutes: number;
  retryMaxAttempts: number;
  retryIntervalsMinutes: number[];
  maxSizeMb: number;
  blockedExtensions: string[];
  includeInline: boolean;
  timeZone: string;
}

export interface PipelineContext {
  providerFor(mailbox: { email: string; provider: string }): MailProvider;
  settings(): Promise<PipelineSettings>;
  now(): Date;
}

export async function loadSettings(): Promise<PipelineSettings> {
  const rows = await prisma.setting.findMany();
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, unknown>;
  const num = (k: string, d: number) => (typeof s[k] === 'number' ? (s[k] as number) : d);
  return {
    syncIntervalMinutes: num('sync.intervalMinutes', 5),
    retryMaxAttempts: num('retry.maxAttempts', 5),
    retryIntervalsMinutes: Array.isArray(s['retry.intervalsMinutes']) ? (s['retry.intervalsMinutes'] as number[]).map(Number) : [1, 5, 15, 60],
    maxSizeMb: num('attachments.maxSizeMb', 150),
    blockedExtensions: Array.isArray(s['attachments.blockedExtensions']) ? (s['attachments.blockedExtensions'] as string[]) : DEFAULT_BLOCKED_EXTENSIONS,
    includeInline: s['attachments.includeInline'] === true,
    timeZone: typeof s['general.businessTimeZone'] === 'string' ? (s['general.businessTimeZone'] as string) : (process.env.BUSINESS_TIMEZONE ?? 'Asia/Kolkata'),
  };
}

export class NotConfiguredError extends Error {}

export function graphConfigured(): boolean {
  return Boolean(process.env.M365_TENANT_ID?.trim() && process.env.M365_CLIENT_ID?.trim() && (process.env.M365_CERT_PATH?.trim() || process.env.M365_CLIENT_SECRET?.trim()));
}

let m365: M365Provider | null = null;

/** Real context used by the running worker. Tests pass their own (fake provider, fixed clock). */
export const defaultContext: PipelineContext = {
  providerFor(mailbox) {
    if (mailbox.provider !== 'M365') throw new NotConfiguredError(`Provider ${mailbox.provider} is not supported yet`);
    if (!graphConfigured()) throw new NotConfiguredError('Microsoft 365 connection is not configured (see docs/ENTRA-SETUP.md)');
    m365 ??= new M365Provider(graphConfigFromEnv());
    return m365;
  },
  settings: loadSettings,
  now: () => new Date(),
};
