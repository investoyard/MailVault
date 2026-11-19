import { describe, expect, it } from 'vitest';
import { fileExtension, numberedFileName, sanitizeFileName } from '../src/filename.js';
import { buildDestinationFolder, renderPattern } from '../src/path-pattern.js';

describe('sanitizeFileName', () => {
  it('keeps normal names', () => {
    expect(sanitizeFileName('Invoice-1234.pdf')).toBe('Invoice-1234.pdf');
  });
  it('blocks path traversal', () => {
    expect(sanitizeFileName('..\\..\\Windows\\evil.dll')).toBe('evil.dll');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
  });
  it('replaces invalid characters', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*.txt')).toBe('a_b_c_d_e_f_g_.txt');
  });
  it('escapes reserved device names', () => {
    expect(sanitizeFileName('CON.pdf')).toBe('_CON.pdf');
    expect(sanitizeFileName('nul')).toBe('_nul');
  });
  it('strips trailing dots and spaces', () => {
    expect(sanitizeFileName('report.pdf. . ')).toBe('report.pdf');
  });
  it('falls back when empty', () => {
    expect(sanitizeFileName('...')).toBe('attachment');
  });
  it('limits length but keeps extension', () => {
    const out = sanitizeFileName(`${'x'.repeat(300)}.xlsx`, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith('.xlsx')).toBe(true);
  });
});

describe('helpers', () => {
  it('fileExtension', () => {
    expect(fileExtension('A.PDF')).toBe('pdf');
    expect(fileExtension('noext')).toBe('');
  });
  it('numberedFileName', () => {
    expect(numberedFileName('invoice.pdf', 2)).toBe('invoice (2).pdf');
    expect(numberedFileName('README', 1)).toBe('README (1)');
  });
});

describe('path patterns', () => {
  const ctx = {
    receivedAt: new Date('2026-11-12T19:30:00Z'), // 01:00 on 13 Nov in IST
    timeZone: 'Asia/Kolkata',
    senderEmail: 'Billing@Vendor.com',
    subject: 'Invoice: 12/2026',
    ruleName: 'Vendor Invoices',
    mailbox: 'accounts@company.com',
  };

  it('uses the business time zone for dates', () => {
    expect(renderPattern('{yyyy}-{MM}-{dd}', ctx)).toBe('2026-11-13');
  });

  it('renders month names, quarters and the financial year', () => {
    expect(renderPattern('{MMMM}, {yyyy}', ctx)).toBe('November, 2026');
    expect(renderPattern('{MMM}-{yy}', ctx)).toBe('Nov-26');
    expect(renderPattern('{Quarter} {FY} {FYQuarter}', ctx)).toBe('Q4 2026-27 Q3');
    const at = (iso: string) => renderPattern('{MMMM} {Quarter} {FY} {FYQuarter}', { ...ctx, receivedAt: new Date(iso) });
    expect(at('2026-04-01T00:00:00+05:30')).toBe('April Q2 2026-27 Q1');
    expect(at('2026-03-31T23:59:00+05:30')).toBe('March Q1 2025-26 Q4');
    expect(at('2027-01-15T10:00:00+05:30')).toBe('January Q1 2026-27 Q4');
    expect(at('2099-12-31T10:00:00+05:30')).toBe('December Q4 2099-00 Q3');
  });

  it('keeps "April, 2026" as one folder', () => {
    const folder = buildDestinationFolder('D:\\Out', { subfolderPattern: '{FY}\\{MMMM}, {yyyy}' }, { ...ctx, receivedAt: new Date('2026-04-07T10:00:00+05:30') });
    expect(folder).toBe('D:\\Out\\2026-27\\April, 2026');
  });

  it('sanitizes token values so subjects cannot add folders', () => {
    expect(renderPattern('{Subject}', ctx)).toBe('Invoice_ 12_2026');
  });

  it('builds a UNC destination folder', () => {
    const folder = buildDestinationFolder(
      '\\\\fs01\\Finance\\Invoices\\',
      { subfolderPattern: '{SenderDomain}\\{yyyy}\\{MM}' },
      ctx,
    );
    expect(folder).toBe('\\\\fs01\\Finance\\Invoices\\vendor.com\\2026\\11');
  });

  it('drops ".." segments', () => {
    const folder = buildDestinationFolder('D:\\Out', { subfolderPattern: '..\\..\\Windows' }, ctx);
    expect(folder).toBe('D:\\Out\\Windows');
  });
});
