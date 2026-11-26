// Reads a labelled value from an email body, e.g. the "EXECUTION DATE" column of a bank's table,
// for the {BodyDate:<label>} file-name token. Pure string work: no DOM, works for HTML and plain text.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Visible text of an HTML fragment, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\r\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/[:\s]+$/, '').trim().toLowerCase();

/** Rows of every table in the HTML, each row a list of cell texts. */
function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cells = [...tr[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map((c) => htmlToText(c[1]!).replace(/\s+/g, ' '));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/**
 * Text values found next to a label, best guess first:
 * the cell below a table header, the cell to the right of it, then "Label: value" in the text.
 */
export function findBodyValues(body: string, label: string): string[] {
  const want = norm(label);
  if (!want) return [];
  const found: string[] = [];
  const isHtml = /<[a-z][\s\S]*>/i.test(body);
  if (isHtml) {
    const rows = tableRows(body);
    rows.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (norm(cell) !== want) return;
        const below = rows[r + 1]?.[c];
        if (below) found.push(below);
        const right = row[c + 1];
        if (right) found.push(right);
      });
    });
  }
  const text = isHtml ? htmlToText(body) : body;
  const esc = label.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  for (const m of text.matchAll(new RegExp(`${esc}\\s*[:=-]?\\s*([^\\n]{1,60})`, 'gi'))) found.push(m[1]!.trim());
  return found;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Calendar date (UTC midnight) from "25/11/2026", "26-11-2026", "25.11.2026", "2026-11-25", "25-Nov-2026", "25 November 2026". Day first. */
export function parseLooseDate(s: string): Date | undefined {
  const make = (y: number, m: number, d: number) => {
    if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : undefined;
  };
  let m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(s);
  if (m) return make(+m[1]!, +m[2]!, +m[3]!);
  m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/.exec(s);
  if (m) return make(+m[3]!, +m[2]!, +m[1]!);
  m = /\b(\d{1,2})(?:st|nd|rd|th)?[-\s.]+([a-z]{3,9})\.?[-\s.,]+(\d{4})\b/i.exec(s);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1;
    if (month) return make(+m[3]!, month, +m[1]!);
  }
  return undefined;
}

/** First date found next to the label in the email body (UTC midnight of that calendar day). */
export function findBodyDate(body: string, label: string): Date | undefined {
  for (const v of findBodyValues(body, label)) {
    const d = parseLooseDate(v);
    if (d) return d;
  }
  return undefined;
}
