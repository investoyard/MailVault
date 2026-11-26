import { describe, expect, it } from 'vitest';
import { findBodyDate, parseLooseDate } from '../src/body-fields.js';
import { buildFileName, unknownTokens } from '../src/path-pattern.js';

// Shape of the ICICI "IPO Allotment / Credit received" email: header row + value row.
const ipo = (date: string, extra = '') => `<html><body><p>Dear Sir/ Ma'am,</p>
<table style="width:1296px"><tr><td><b>CLIENT ID</b></td><td><span>CLIENT&nbsp;NAME</span></td><td>ALLOTTED QTY</td><td><p>EXECUTION
 DATE</p></td>${extra ? '<td>LOCKIN RELEASE DATE</td>' : ''}</tr>
<tr><td>20728063</td><td>FINWAVE GLOBAL OPPORTUNITIES FUND</td><td>17836</td><td>${date}</td>${extra ? `<td>${extra}</td>` : ''}</tr></table>
<p>Sincerely, Team</p></body></html>`;
const day = (d?: Date) => d?.toISOString().slice(0, 10);

describe('findBodyDate', () => {
  it('reads the value below a table header', () => {
    expect(day(findBodyDate(ipo('25/11/2026'), 'EXECUTION DATE'))).toBe('2026-11-25');
    expect(day(findBodyDate(ipo('26-11-2026', 'None'), 'execution date'))).toBe('2026-11-26');
  });
  it('reads "Label: value" text', () => {
    expect(day(findBodyDate('Trade done.\nExecution Date: 03.12.2026\nThanks', 'EXECUTION DATE'))).toBe('2026-12-03');
    expect(day(findBodyDate('<p>Value date : 5-Dec-2026</p>', 'Value date'))).toBe('2026-12-05');
  });
  it('returns undefined when missing', () => {
    expect(findBodyDate(ipo('25/11/2026'), 'SETTLEMENT DATE')).toBeUndefined();
    expect(findBodyDate(ipo('n/a'), 'EXECUTION DATE')).toBeUndefined();
  });
  it('parses day-first dates', () => {
    expect(day(parseLooseDate('2026-11-25'))).toBe('2026-11-25');
    expect(day(parseLooseDate('25 November 2026'))).toBe('2026-11-25');
    expect(parseLooseDate('31/02/2026')).toBeUndefined();
  });
});

describe('{BodyDate} token', () => {
  const ctx = { receivedAt: new Date('2026-11-26T05:09:24Z'), timeZone: 'Asia/Kolkata', senderEmail: 'croteam@icici.bank.in', ruleName: 'IPO', mailbox: 'aif@finwave.co' };
  it('names the email PDF by the execution date', () => {
    expect(buildFileName('{BodyDate:EXECUTION DATE}', 'subject.pdf', { ...ctx, emailBody: ipo('25/11/2026') })).toBe('25.11.2026.pdf');
    expect(buildFileName('{BodyDate:EXECUTION DATE|yyyy-MM-dd} IPO', 'x.pdf', { ...ctx, emailBody: ipo('25/11/2026') })).toBe('2026-11-25 IPO.pdf');
  });
  it('falls back to the received date', () => {
    expect(buildFileName('{BodyDate:EXECUTION DATE}', 'subject.pdf', ctx)).toBe('26.11.2026.pdf');
  });
  it('is validated', () => {
    expect(unknownTokens('{BodyDate:EXECUTION DATE}')).toEqual([]);
    expect(unknownTokens('{BodyDate:EXECUTION DATE|dd/MM}')).toEqual(['{BodyDate:EXECUTION DATE|dd/MM}']);
    expect(unknownTokens('{BodyDate:}')).toEqual(['{BodyDate:}']);
  });
});
