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
  /** "Today" for {Today…} tokens: when the file is saved. Defaults to the current time. */
  now?: Date;
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
  '{Subject}', '{RuleName}', '{Mailbox}', '{OriginalName}', '{BaseName}', '{Ext}',
  '{Today}',
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
  '{OriginalName}': 'Original attachment name: INV-1042 (the extension .pdf is always added at the end)',
  '{BaseName}': 'Original name without extension: INV-1042',
  '{Ext}': 'File extension: pdf (not needed at the end; it is added automatically)',
  '{Today}': 'Date the file is saved (not the email date): 20261119',
};

/** Characters a custom date format may use: yyyy yy MMMM MMM MM M dd d HH mm ss and separators. */
const DATE_FORMAT = /^[yMdHms\-_. ,]+$/;
const DATE_PART = /yyyy|yy|MMMM|MMM|MM|M|dd|d|HH|mm|ss/g;

/**
 * Ready-made date formats offered as clickable tags. {Date:…} uses the email's received date,
 * {Today:…} the date the file is saved. Any combination of the parts is allowed.
 */
export const DATE_FORMAT_PRESETS = ['dd-MM-yyyy', 'yyyy-MM-dd', 'ddMMyyyy', 'dd.MM.yyyy', 'dd-MMM-yyyy', 'dd MMMM yyyy', 'MMM-yyyy', 'yyyyMMdd_HHmm'] as const;
export const DATE_FORMAT_PARTS_HELP = 'yyyy 2026 · yy 26 · MMMM April · MMM Apr · MM 04 · M 4 · dd 07 · d 7 · HH 14 · mm 30 · ss 05';

/** Formats a date in the business time zone, e.g. formatDate(d, 'dd-MMM-yyyy', tz) = "07-Apr-2026". */
export function formatDate(date: Date, format: string, timeZone: string): string {
  const d = zonedParts(date, timeZone);
  const month = Number(d.MM);
  const parts: Record<string, string> = {
    yyyy: d.yyyy,
    yy: d.yyyy.slice(-2),
    MMMM: MONTHS[month - 1]!,
    MMM: MONTHS[month - 1]!.slice(0, 3),
    MM: d.MM,
    M: String(month),
    dd: d.dd,
    d: String(Number(d.dd)),
    HH: d.HH,
    mm: d.mm,
    ss: d.ss,
  };
  return format.replace(DATE_PART, (p) => parts[p] ?? p);
}

const TOKEN = /\{(\w+)(?::([^{}]*))?\}/g;

/** Tokens in a pattern that MailVault does not know (typos), for a warning in the rule editor. */
export function unknownTokens(pattern: string): string[] {
  const known = new Set<string>(PATTERN_TOKENS.map((t) => t.slice(1, -1)));
  const bad: string[] = [];
  for (const m of pattern.matchAll(TOKEN)) {
    const [whole, key, fmt] = m;
    const ok = fmt !== undefined ? (key === 'Date' || key === 'Today') && DATE_FORMAT.test(fmt) : known.has(key!);
    if (!ok) bad.push(whole);
  }
  return bad;
}

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
    BaseName: baseName(ctx.originalName ?? ''),
    Ext: extOf(ctx.originalName ?? ''),
    Today: formatDate(ctx.now ?? new Date(), 'yyyyMMdd', ctx.timeZone),
  };
  return pattern.replace(TOKEN, (match, key: string, fmt?: string) => {
    let value: string | undefined;
    if (fmt !== undefined) {
      if ((key === 'Date' || key === 'Today') && DATE_FORMAT.test(fmt)) {
        value = formatDate(key === 'Date' ? ctx.receivedAt : (ctx.now ?? new Date()), fmt, ctx.timeZone);
      }
    } else if (key in values) value = values[key];
    // Slashes inside a value are content (e.g. "12/2026"), not folders: replace them before sanitizing.
    return value === undefined ? match : sanitizeFileName(value.replace(/[\\/]/g, '_'), 80, '_');
  });
}

const extOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '');
const baseName = (name: string) => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name);

/**
 * Final file name for an attachment from the rule's file-name pattern.
 * The pattern names the file *without* its extension; the original extension is always
 * added once at the end. So {OriginalName} inside a longer pattern stands for the name
 * without extension, and a trailing {Ext} / .{Ext} is not repeated:
 *   "{OriginalName}_{Date:ddMMyyyy}" → "INV-1042_19112026.zip"
 *   "{BaseName}{Ext}" or "{BaseName}.{Ext}" → "INV-1042.zip"
 */
export function buildFileName(pattern: string | undefined, original: string, ctx: PatternContext): string {
  const p = pattern?.trim() || '{OriginalName}';
  if (p === '{OriginalName}') return sanitizeFileName(original);
  const ext = extOf(original);
  const stem = p.replace(/\.?\{Ext\}$/, '').replace(/\{OriginalName\}/g, '{BaseName}');
  let name = renderPattern(stem, { ...ctx, originalName: original }).replace(/[. ]+$/, '');
  // A literal extension typed by hand ("{BaseName}.zip") is not doubled.
  if (ext && name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) name = name.slice(0, -(ext.length + 1));
  return sanitizeFileName(ext ? `${name || baseName(original)}.${ext}` : name || original);
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
