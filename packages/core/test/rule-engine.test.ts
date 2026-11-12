import { describe, expect, it } from 'vitest';
import { attachmentFilterSchema, ruleConditionsSchema } from '@mailvault/shared';
import { addressMatches, evaluateConditions, filterAttachments, stripReplyPrefixes } from '../src/rule-engine.js';
import type { AttachmentInfo } from '../src/provider.js';

const email = {
  from: 'Billing@Acme-Supplies.com',
  to: ['accounts@company.com'],
  cc: ['cfo@company.com'],
  subject: 'RE: FW: Invoice INV-1001 for October',
  receivedAt: new Date('2026-11-10T10:00:00Z'),
};
const cond = (c: object) => ruleConditionsSchema.parse(c);

describe('addressMatches', () => {
  it('matches exact addresses case-insensitively', () => {
    expect(addressMatches('billing@acme-supplies.com', 'Billing@ACME-supplies.com')).toBe(true);
  });
  it('matches domain wildcards including subdomains', () => {
    expect(addressMatches('*@acme.com', 'a@acme.com')).toBe(true);
    expect(addressMatches('*@acme.com', 'a@mail.acme.com')).toBe(true);
    expect(addressMatches('*@acme.com', 'a@notacme.com')).toBe(false);
  });
});

describe('stripReplyPrefixes', () => {
  it('removes stacked RE/FW prefixes', () => {
    expect(stripReplyPrefixes('RE: FW: Fwd: Invoice')).toBe('Invoice');
    expect(stripReplyPrefixes('Invoice RE: x')).toBe('Invoice RE: x');
  });
});

describe('evaluateConditions', () => {
  it('matches when no conditions are set', () => {
    expect(evaluateConditions(cond({}), email).matched).toBe(true);
  });

  it('sender include with wildcard', () => {
    expect(evaluateConditions(cond({ senderInclude: ['*@acme-supplies.com'] }), email).matched).toBe(true);
    expect(evaluateConditions(cond({ senderInclude: ['*@other.com'] }), email).matched).toBe(false);
  });

  it('exclude always wins over include', () => {
    const r = evaluateConditions(cond({ senderInclude: ['*@acme-supplies.com'], senderExclude: ['billing@acme-supplies.com'] }), email);
    expect(r.matched).toBe(false);
    expect(r.checks.find((c) => !c.passed)?.condition).toBe('Sender not excluded');
  });

  it('To and CC lists', () => {
    expect(evaluateConditions(cond({ recipients: ['accounts@company.com'], cc: ['*@company.com'] }), email).matched).toBe(true);
    expect(evaluateConditions(cond({ cc: ['someone@else.com'] }), email).matched).toBe(false);
  });

  it('subject exact ignores reply prefixes by default', () => {
    expect(evaluateConditions(cond({ subjectExact: 'invoice inv-1001 for october' }), email).matched).toBe(true);
    expect(evaluateConditions(cond({ subjectExact: 'invoice inv-1001 for october', ignoreReplyPrefixes: false }), email).matched).toBe(false);
  });

  it('keywords ANY vs ALL', () => {
    expect(evaluateConditions(cond({ subjectKeywords: ['invoice', 'statement'] }), email).matched).toBe(true);
    expect(evaluateConditions(cond({ subjectKeywords: ['invoice', 'statement'], keywordMode: 'ALL' }), email).matched).toBe(false);
    expect(evaluateConditions(cond({ subjectKeywords: ['invoice', 'october'], keywordMode: 'ALL' }), email).matched).toBe(true);
  });

  it('date range', () => {
    expect(evaluateConditions(cond({ receivedFrom: '2026-11-01T00:00:00Z', receivedTo: '2026-11-30T00:00:00Z' }), email).matched).toBe(true);
    expect(evaluateConditions(cond({ receivedFrom: '2026-11-11T00:00:00Z' }), email).matched).toBe(false);
  });

  it('asks for the body only when everything else passes', () => {
    const c = cond({ senderInclude: ['*@acme-supplies.com'], bodyContains: 'GSTIN' });
    const first = evaluateConditions(c, email);
    expect(first).toMatchObject({ matched: false, needsBody: true });
    expect(evaluateConditions(c, email, 'Our GSTIN is 27AAA').matched).toBe(true);
    expect(evaluateConditions(c, email, 'no tax id').matched).toBe(false);

    const failing = evaluateConditions(cond({ senderInclude: ['*@x.com'], bodyContains: 'GSTIN' }), email);
    expect(failing.needsBody).toBe(false);
  });

  it('explains every condition', () => {
    const r = evaluateConditions(cond({ senderInclude: ['*@acme-supplies.com'], subjectContains: 'statement' }), email);
    expect(r.checks.map((c) => [c.condition, c.passed])).toEqual([
      ['Sender', true],
      ['Subject contains', false],
    ]);
  });
});

describe('filterAttachments', () => {
  const att = (name: string, extra: Partial<AttachmentInfo> = {}): AttachmentInfo => ({
    id: name,
    name,
    size: 100 * 1024,
    isInline: false,
    kind: 'file',
    ...extra,
  });
  const policy = { blockedExtensions: ['exe', 'js'], maxSizeMb: 10, includeInline: false };
  const filter = (f: object) => attachmentFilterSchema.parse(f);
  const decide = (f: object, list: AttachmentInfo[]) =>
    filterAttachments(filter(f), list, policy).map((d) => [d.saveName, d.include, d.reason ?? null]);

  it('downloads normal files and skips problem types with reasons', () => {
    expect(
      decide({}, [
        att('a.pdf'),
        att('logo.png', { isInline: true }),
        att('evil.exe'),
        att('big.zip', { size: 20 * 1024 * 1024 }),
        att('link', { kind: 'reference' }),
        att('smime.p7m'),
        att('Fwd mail', { kind: 'item' }),
      ]),
    ).toEqual([
      ['a.pdf', true, null],
      ['logo.png', false, 'Inline image excluded'],
      ['evil.exe', false, 'Blocked file type (.exe)'],
      ['big.zip', false, 'Larger than the 10 MB limit'],
      ['link', false, 'Cloud link (OneDrive/SharePoint), not a file'],
      ['smime.p7m', false, 'Encrypted message, attachment cannot be read'],
      ['Fwd mail.eml', true, null],
    ]);
  });

  it('selected extensions, name filters and size limits', () => {
    const list = [att('INV-1.pdf'), att('INV-1.xlsx'), att('terms.pdf'), att('tiny.pdf', { size: 500 })];
    expect(decide({ mode: 'SELECTED', extensions: ['pdf'], excludeNames: ['terms'], minSizeKb: 1 }, list).map((d) => d[1])).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(decide({ nameContains: 'inv' }, list).map((d) => d[1])).toEqual([true, true, false, false]);
  });

  it('allowMultiple=false keeps only the first eligible file', () => {
    expect(decide({ allowMultiple: false }, [att('evil.exe'), att('a.pdf'), att('b.pdf')]).map((d) => d[1])).toEqual([false, true, false]);
  });

  it('rule can opt in to inline images', () => {
    expect(decide({ includeInline: true }, [att('logo.png', { isInline: true })])[0]![1]).toBe(true);
  });
});
