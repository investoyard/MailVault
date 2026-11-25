import { describe, expect, it } from 'vitest';
import { fileExtension, numberedFileName, sanitizeFileName } from '../src/filename.js';
import { buildDestinationFolder, buildFileName, renderPattern, unknownTokens } from '../src/path-pattern.js';

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
    expect(renderPattern('FY {FYFull}', ctx)).toBe('FY 2026-2027');
    expect(renderPattern('{FYFull}', { ...ctx, receivedAt: new Date('2027-03-31T23:00:00+05:30') })).toBe('2026-2027');
    expect(renderPattern('{FYFull}', { ...ctx, receivedAt: new Date('2027-04-01T00:30:00+05:30') })).toBe('2027-2028');
    expect(unknownTokens('{FYFull}\{FY}')).toEqual([]);
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

  it('keeps long typed folder names whole (was cut at 80 characters)', () => {
    const long = 'Client Daily Statement-Orient- 0021 Fin Order API Futures and Options- Gold Silver'; // 82 characters
    const folder = buildDestinationFolder(
      '\\\\fs\\share',
      { subfolderPattern: `{FYFull}/\\20. Orient Data\\${long}\\{MMM}, {yyyy}` },
      { ...ctx, receivedAt: new Date('2026-11-25T10:00:00+05:30') },
    );
    expect(folder).toBe(`\\\\fs\\share\\2026-2027\\20. Orient Data\\${long}\\Nov, 2026`);
    // Still safe: invalid characters replaced, trailing dots dropped, very long names limited to 200.
    expect(buildDestinationFolder('D:\\Out', { subfolderPattern: 'A:B?. ' }, ctx)).toBe('D:\\Out\\A_B_');
    expect(buildDestinationFolder('D:\\Out', { subfolderPattern: 'x'.repeat(300) }, ctx)).toBe(`D:\\Out\\${'x'.repeat(200)}`);
    expect(buildDestinationFolder('D:\\Out', { subfolderPattern: '..\\con\\ok' }, ctx)).toBe('D:\\Out\\_con\\ok');
  });

  it('renders custom date formats for the email date and today', () => {
    const now = new Date('2026-11-19T04:00:00Z'); // 09:30 on 19 Nov in IST
    expect(renderPattern('{Date:dd-MM-yyyy}', ctx)).toBe('13-11-2026');
    expect(renderPattern('{Date:dd-MMM-yyyy} {Date:d MMMM yy}', ctx)).toBe('13-Nov-2026 13 November 26');
    expect(renderPattern('{Date:yyyyMMdd_HHmmss}', ctx)).toBe('20261113_010000');
    expect(renderPattern('{Today:dd.MM.yyyy} {Today}', { ...ctx, now })).toBe('19.11.2026 20261119');
    // Slashes would create folders; they are not allowed in a format, so the token stays visible as a typo.
    expect(renderPattern('{Date:dd/MM}', ctx)).toBe('{Date:dd/MM}');
  });

  it('builds file names and keeps the extension', () => {
    const at = { ...ctx, now: new Date('2026-11-19T04:00:00Z') };
    expect(buildFileName('{OriginalName}', 'INV 1042.pdf', at)).toBe('INV 1042.pdf');
    expect(buildFileName('', 'INV 1042.pdf', at)).toBe('INV 1042.pdf');
    expect(buildFileName('{BaseName}_{Date:dd-MM-yyyy}', 'Statement.zip', at)).toBe('Statement_13-11-2026.zip');
    expect(buildFileName('{Today:yyyy-MM-dd}_{OriginalName}', 'a.PDF', at)).toBe('2026-11-19_a.PDF');
    expect(buildFileName('{BaseName}.{Ext}', 'x.tar.gz', at)).toBe('x.tar.gz');
    // The extension always ends up once, at the end.
    expect(buildFileName('{OriginalName}_{Date:ddMMyyyy}', 'INV-1042.zip', at)).toBe('INV-1042_13112026.zip');
    expect(buildFileName('{BaseName}{Ext}', 'INV-1042.zip', at)).toBe('INV-1042.zip');
    expect(buildFileName('{BaseName}.zip', 'INV-1042.zip', at)).toBe('INV-1042.zip');
    expect(buildFileName('{Ext}_{BaseName}', 'INV-1042.zip', at)).toBe('zip_INV-1042.zip');
    expect(buildFileName('{BaseName}_{yyyy}', 'README', at)).toBe('README_2026');
    expect(buildFileName('Report {MMMM} {yyyy}', 'r.xlsx', at)).toBe('Report November 2026.xlsx');
  });

  it('lists unknown placeholders', () => {
    expect(unknownTokens('{BaseName}_{Date:dd-MM-yyyy}_{Today:HHmm}')).toEqual([]);
    expect(unknownTokens('{yyy}_{Date:dd/MM}_{Foo:dd}')).toEqual(['{yyy}', '{Date:dd/MM}', '{Foo:dd}']);
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
