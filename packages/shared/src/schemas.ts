import { z } from 'zod';
import { DUPLICATE_POLICIES, MAILBOX_AUTH_MODES } from './enums.js';

/** Email address or a domain wildcard such as *@vendor.com */
const addressPattern = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*|[^\s@]+)@[^\s@]+\.[^\s@]+$/, 'Use name@domain.com or *@domain.com');

export const ruleConditionsSchema = z.object({
  senderInclude: z.array(addressPattern).default([]),
  senderExclude: z.array(addressPattern).default([]),
  recipients: z.array(addressPattern).default([]),
  cc: z.array(addressPattern).default([]),
  subjectContains: z.string().trim().optional(),
  subjectExact: z.string().trim().optional(),
  subjectKeywords: z.array(z.string().trim().min(1)).default([]),
  keywordMode: z.enum(['ANY', 'ALL']).default('ANY'),
  ignoreReplyPrefixes: z.boolean().default(true),
  bodyContains: z.string().trim().optional(),
  receivedFrom: z.iso.datetime().optional(),
  receivedTo: z.iso.datetime().optional(),
});
export type RuleConditions = z.infer<typeof ruleConditionsSchema>;

export const attachmentFilterSchema = z.object({
  mode: z.enum(['ALL', 'SELECTED']).default('ALL'),
  extensions: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9]+$/)).default([]),
  nameContains: z.string().trim().optional(),
  excludeNames: z.array(z.string().trim()).default([]),
  minSizeKb: z.number().int().nonnegative().optional(),
  maxSizeKb: z.number().int().positive().optional(),
  allowMultiple: z.boolean().default(true),
  includeInline: z.boolean().default(false),
  /** Unpack .zip attachments and save the files inside that match this rule. */
  extractArchives: z.boolean().default(false),
  /** Unpack attached emails (.eml/.msg) and save their attachments that match this rule. */
  extractEmails: z.boolean().default(false),
  /** Also save the .zip/.eml/.msg itself when its contents are extracted. */
  keepContainer: z.boolean().default(false),
});
export type AttachmentFilter = z.infer<typeof attachmentFilterSchema>;

export const downloadConfigSchema = z.object({
  destinationId: z.string().min(1),
  subfolderPattern: z.string().trim().default(''),
  dateSubfolders: z.boolean().default(false),
  senderSubfolders: z.boolean().default(false),
  fileNamePattern: z.string().trim().default('{OriginalName}'),
  duplicatePolicy: z.enum(DUPLICATE_POLICIES).default('SMART'),
  autoDownload: z.boolean().default(true),
  setFileDateToReceived: z.boolean().default(true),
});
export type DownloadConfig = z.infer<typeof downloadConfigSchema>;

export const ruleInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  mailboxId: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(1).max(9999).default(100),
  stopFurtherRules: z.boolean().default(false),
  simulationMode: z.boolean().default(false),
  conditions: ruleConditionsSchema,
  attachments: attachmentFilterSchema,
  download: downloadConfigSchema,
});
export type RuleInput = z.infer<typeof ruleInputSchema>;

export const mailboxInputSchema = z.object({
  email: z.email().trim().toLowerCase(),
  displayName: z.string().trim().max(120).optional(),
  authMode: z.enum(MAILBOX_AUTH_MODES).default('APP_ONLY'),
  enabled: z.boolean().default(true),
  syncIntervalMinutes: z.number().int().min(1).max(1440).optional(),
  monitoringStartAt: z.iso.datetime().optional(),
});
export type MailboxInput = z.infer<typeof mailboxInputSchema>;

export const destinationInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  basePath: z
    .string()
    .trim()
    .min(3)
    .refine((p) => /^[a-zA-Z]:\\/.test(p) || p.startsWith('\\\\'), 'Use a local path (D:\\...) or UNC path (\\\\server\\share)'),
  lowSpaceThresholdMb: z.number().int().positive().default(1024),
  createIfMissing: z.boolean().default(true),
});
export type DestinationInput = z.infer<typeof destinationInputSchema>;

export const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});
