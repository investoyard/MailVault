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
