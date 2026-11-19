import { sanitizeFileName } from './filename.js';

export interface PatternContext {
  receivedAt: Date;
  timeZone: string;
  senderEmail: string;
  senderName?: string;
  subject?: string;
  ruleName: string;
  mailbox: string;
  originalName?: string;
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { yyyy: get('year'), MM: get('month'), dd: get('day'), HH: get('hour'), mm: get('minute'), ss: get('second') };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const PATTERN_TOKENS = [
  '{yyyy}', '{yy}', '{MM}', '{MMM}', '{MMMM}', '{dd}', '{yyyyMMdd}', '{HHmmss}',
  '{Quarter}', '{FY}', '{FYQuarter}',
  '{SenderEmail}', '{SenderDomain}', '{SenderName}',
  '{Subject}', '{RuleName}', '{Mailbox}', '{OriginalName}',
] as const;
export type PatternToken = (typeof PATTERN_TOKENS)[number];

/** Plain-English help for each token (example: email received 7 Apr 2026). */
export const PATTERN_TOKEN_HELP: Record<PatternToken, string> = {
  '{yyyy}': 'Year: 2026',
  '{yy}': 'Year, 2 digits: 26',
  '{MM}': 'Month number: 04',
  '{MMM}': 'Month, short name: Apr',
  '{MMMM}': 'Month name: April',
  '{dd}': 'Day: 07',
  '{yyyyMMdd}': 'Date: 20260407',
  '{HHmmss}': 'Time received: 143005',
  '{Quarter}': 'Calendar quarter: Q2 (Apr–Jun)',
  '{FY}': 'Financial year (April–March): 2026-27',
  '{FYQuarter}': 'Financial-year quarter: Q1 (Apr–Jun)',
  '{SenderEmail}': 'Sender address: billing@vendor.com',
  '{SenderDomain}': 'Sender domain: vendor.com',
  '{SenderName}': 'Sender display name',
  '{Subject}': 'Email subject (first 60 characters)',
  '{RuleName}': 'Name of this rule',
  '{Mailbox}': 'Mailbox address',
  '{OriginalName}': 'Original attachment name',
};

/**
 * Replaces tokens in a folder or file-name pattern. Each token value is sanitized,
 * so a subject like "Invoice: 12/2026" can never create extra folders.
 * Dates use the business time zone (Graph returns UTC).
 */
export function renderPattern(pattern: string, ctx: PatternContext): string {
  const d = zonedParts(ctx.receivedAt, ctx.timeZone);
  const sender = ctx.senderEmail.toLowerCase();
  const month = Number(d.MM); // 1-12
  const year = Number(d.yyyy);
  // Indian financial year: April to March. FY 2026-27 runs 1 Apr 2026 – 31 Mar 2027.
  const fyStart = month >= 4 ? year : year - 1;
  const values: Record<string, string> = {
    yyyy: d.yyyy,
    yy: d.yyyy.slice(-2),
    MM: d.MM,
    MMM: MONTHS[month - 1]!.slice(0, 3),
    MMMM: MONTHS[month - 1]!,
    dd: d.dd,
    Quarter: `Q${Math.ceil(month / 3)}`,
    FY: `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`,
    FYQuarter: `Q${Math.ceil((((month + 8) % 12) + 1) / 3)}`,
    yyyyMMdd: `${d.yyyy}${d.MM}${d.dd}`,
    HHmmss: `${d.HH}${d.mm}${d.ss}`,
    SenderEmail: sender,
    SenderDomain: sender.split('@')[1] ?? 'unknown',
    SenderName: ctx.senderName || sender.split('@')[0] || 'unknown',
    Subject: (ctx.subject || 'no-subject').slice(0, 60),
    RuleName: ctx.ruleName,
    Mailbox: ctx.mailbox.toLowerCase(),
    OriginalName: ctx.originalName ?? '',
  };
  return pattern.replace(/\{(\w+)\}/g, (match, key: string) =>
    // Slashes inside a value are content (e.g. "12/2026"), not folders: replace them before sanitizing.
    key in values ? sanitizeFileName((values[key] ?? '').replace(/[\\/]/g, '_'), 80, '_') : match,
  );
}

/**
 * Builds the final folder: base path + optional sender/date subfolders + custom pattern.
 * Every segment is sanitized; ".." segments are dropped so the result stays under basePath.
 */
export function buildDestinationFolder(
  basePath: string,
  opts: { subfolderPattern?: string; dateSubfolders?: boolean; senderSubfolders?: boolean },
  ctx: PatternContext,
): string {
  const segments: string[] = [];
  if (opts.senderSubfolders) segments.push('{SenderEmail}');
  if (opts.dateSubfolders) segments.push('{yyyy}', '{MM}', '{dd}');
  if (opts.subfolderPattern) segments.push(...opts.subfolderPattern.split(/[\\/]+/));

  const rendered = segments
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => sanitizeFileName(renderPattern(s, ctx), 80, '_'));

  const base = basePath.replace(/[\\/]+$/, '');
  return [base, ...rendered].join('\\');
}
