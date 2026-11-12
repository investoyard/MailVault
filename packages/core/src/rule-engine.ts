// Rule matching. Pure and deterministic: the same code powers live processing, Rule Testing and simulation.
import type { AttachmentFilter, RuleConditions } from '@mailvault/shared';
import { fileExtension } from './filename.js';
import type { AttachmentInfo } from './provider.js';

export interface EmailFacts {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  receivedAt: Date;
}

export interface ConditionCheck {
  condition: string;
  passed: boolean;
  detail: string;
}

export interface RuleEvaluation {
  matched: boolean;
  /** True when every other condition passed but the body is needed to decide. */
  needsBody: boolean;
  checks: ConditionCheck[];
}

const lc = (s: string) => s.trim().toLowerCase();

/** "name@x.com" matches exactly; "*@x.com" matches any address at x.com (and its subdomains). */
export function addressMatches(pattern: string, address: string): boolean {
  const p = lc(pattern);
  const a = lc(address);
  if (p.startsWith('*@')) {
    const domain = p.slice(2);
    const at = a.lastIndexOf('@');
    if (at < 0) return false;
    const ad = a.slice(at + 1);
    return ad === domain || ad.endsWith(`.${domain}`);
  }
  return p === a;
}

const anyMatch = (patterns: string[], addresses: string[]) =>
  addresses.find((a) => patterns.some((p) => addressMatches(p, a)));

export function stripReplyPrefixes(subject: string): string {
  return subject.replace(/^\s*((re|fw|fwd|aw|wg)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
}

/**
 * Evaluates a rule's email conditions. All configured groups must pass (AND);
 * inside a list any value may match (OR), except keywords in ALL mode.
 * Pass `body` only when it was fetched; otherwise a body condition reports needsBody.
 */
export function evaluateConditions(c: RuleConditions, email: EmailFacts, body?: string | null): RuleEvaluation {
  const checks: ConditionCheck[] = [];
  const add = (condition: string, passed: boolean, detail: string) => checks.push({ condition, passed, detail });

  if (c.senderExclude.length) {
    const hit = anyMatch(c.senderExclude, [email.from]);
    add('Sender not excluded', !hit, hit ? `${email.from} is excluded` : `${email.from} is not in the exclude list`);
  }
  if (c.senderInclude.length) {
    const hit = anyMatch(c.senderInclude, [email.from]);
    add('Sender', !!hit, hit ? `${email.from} matches` : `${email.from} is not one of ${c.senderInclude.join(', ')}`);
  }
  if (c.recipients.length) {
    const hit = anyMatch(c.recipients, email.to);
    add('To', !!hit, hit ? `${hit} matches` : `None of the To addresses match ${c.recipients.join(', ')}`);
  }
  if (c.cc.length) {
    const hit = anyMatch(c.cc, email.cc);
    add('CC', !!hit, hit ? `${hit} matches` : `None of the CC addresses match ${c.cc.join(', ')}`);
  }

  const subject = c.ignoreReplyPrefixes ? stripReplyPrefixes(email.subject) : email.subject.trim();
  const subjectLc = lc(subject);
  if (c.subjectExact) {
    const ok = subjectLc === lc(c.subjectExact);
    add('Subject is exactly', ok, ok ? 'Exact match' : `"${subject}" ≠ "${c.subjectExact}"`);
  }
  if (c.subjectContains) {
    const ok = subjectLc.includes(lc(c.subjectContains));
    add('Subject contains', ok, ok ? `Contains "${c.subjectContains}"` : `"${subject}" does not contain "${c.subjectContains}"`);
  }
  if (c.subjectKeywords.length) {
    const found = c.subjectKeywords.filter((k) => subjectLc.includes(lc(k)));
    const ok = c.keywordMode === 'ALL' ? found.length === c.subjectKeywords.length : found.length > 0;
    add(
      `Subject keywords (${c.keywordMode === 'ALL' ? 'all' : 'any'})`,
      ok,
      found.length ? `Found: ${found.join(', ')}` : `None of: ${c.subjectKeywords.join(', ')}`,
    );
  }
  if (c.receivedFrom || c.receivedTo) {
    const t = email.receivedAt.getTime();
    const ok = (!c.receivedFrom || t >= new Date(c.receivedFrom).getTime()) && (!c.receivedTo || t <= new Date(c.receivedTo).getTime());
    add('Received date', ok, ok ? 'Within the date range' : 'Outside the date range');
  }

  const othersPass = checks.every((x) => x.passed);
  let needsBody = false;
  if (c.bodyContains) {
    if (body === undefined) {
      needsBody = othersPass;
      add('Body contains', false, 'Body not checked yet');
    } else {
      const ok = lc(body ?? '').includes(lc(c.bodyContains));
      add('Body contains', ok, ok ? `Contains "${c.bodyContains}"` : `Body does not contain "${c.bodyContains}"`);
    }
  }

  return { matched: !needsBody && checks.every((x) => x.passed), needsBody, checks };
}

export function ruleNeedsBody(c: RuleConditions): boolean {
  return !!c.bodyContains;
}

// ───────────────────────── Attachments ─────────────────────────

export interface AttachmentPolicy {
  blockedExtensions: string[];
  maxSizeMb: number;
  /** Global default; a rule's own includeInline=true also allows inline files. */
  includeInline: boolean;
}

export interface AttachmentDecision {
  attachment: AttachmentInfo;
  include: boolean;
  /** Name to save as (item attachments get ".eml"). */
  saveName: string;
  reason?: string;
  /** Set when the file's contents should be unpacked instead of (or as well as) saving it. */
  extract?: ContainerKind;
}

export type ContainerKind = 'zip' | 'eml' | 'msg';

/** Archives and attached emails whose contents MailVault can unpack. */
export function containerKindOf(name: string, kind: AttachmentInfo['kind'] = 'file'): ContainerKind | null {
  if (kind === 'item') return 'eml';
  const ext = fileExtension(name);
  return ext === 'zip' ? 'zip' : ext === 'eml' ? 'eml' : ext === 'msg' ? 'msg' : null;
}

/** Decides whether one file found inside an archive/attached email should be saved (same rules, no further unpacking). */
export function acceptInnerFile(f: AttachmentFilter, name: string, size: number, isInline: boolean, policy: AttachmentPolicy): { include: boolean; reason?: string } {
  const plain = { ...f, extractArchives: false, extractEmails: false, allowMultiple: true };
  const [d] = filterAttachments(plain, [{ id: name, name, size, isInline, kind: 'file' }], policy);
  return { include: d!.include, reason: d!.reason };
}

const ENCRYPTED_NAMES = new Set(['smime.p7m', 'message.rpmsg']);

/** Decides, per attachment, whether a rule downloads it and why not. Order of checks matters for clear reasons. */
export function filterAttachments(f: AttachmentFilter, attachments: AttachmentInfo[], policy: AttachmentPolicy): AttachmentDecision[] {
  const blocked = new Set(policy.blockedExtensions.map(lc));
  const exts = new Set(f.extensions.map(lc));
  const excludes = f.excludeNames.map(lc).filter(Boolean);
  let includedCount = 0;

  return attachments.map((a) => {
    const saveName = a.kind === 'item' && !/\.(eml|msg)$/i.test(a.name) ? `${a.name}.eml` : a.name;
    const nameLc = lc(saveName);
    const ext = fileExtension(saveName);
    const skip = (reason: string): AttachmentDecision => ({ attachment: a, include: false, saveName, reason });

    if (a.kind === 'reference') return skip('Cloud link (OneDrive/SharePoint), not a file');
    if (ENCRYPTED_NAMES.has(nameLc)) return skip('Encrypted message, attachment cannot be read');
    if (a.isInline && !(f.includeInline || policy.includeInline)) return skip('Inline image excluded');
    if (blocked.has(ext)) return skip(`Blocked file type (.${ext})`);
    if (a.size > policy.maxSizeMb * 1024 * 1024) return skip(`Larger than the ${policy.maxSizeMb} MB limit`);

    // Archives / attached emails to unpack: the rule's file filters apply to the files inside instead.
    const container = containerKindOf(saveName, a.kind);
    if (container && ((container === 'zip' && f.extractArchives) || (container !== 'zip' && f.extractEmails))) {
      if (!f.allowMultiple && includedCount >= 1) return skip('Rule allows only one attachment per email');
      includedCount++;
      return { attachment: a, include: true, saveName, extract: container };
    }

    if (f.mode === 'SELECTED' && exts.size && !exts.has(ext)) return skip(`File type .${ext || '(none)'} not selected in rule`);
    if (f.nameContains && !nameLc.includes(lc(f.nameContains))) return skip(`Name does not contain "${f.nameContains}"`);
    if (excludes.some((x) => nameLc.includes(x))) return skip('Name is in the exclude list');
    if (f.minSizeKb !== undefined && a.size < f.minSizeKb * 1024) return skip(`Smaller than ${f.minSizeKb} KB`);
    if (f.maxSizeKb !== undefined && a.size > f.maxSizeKb * 1024) return skip(`Larger than ${f.maxSizeKb} KB`);
    if (!f.allowMultiple && includedCount >= 1) return skip('Rule allows only one attachment per email');

    includedCount++;
    return { attachment: a, include: true, saveName };
  });
}
