import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

export const fmtDateTime = (v?: string | Date | null) => (v ? dayjs(v).format('DD MMM YYYY, HH:mm') : '—');
/** Compact date for dense tables: "12 Nov, 09:41" this year, "12 Nov 2025" otherwise. */
export const fmtShort = (v?: string | Date | null) => {
  if (!v) return '—';
  const d = dayjs(v);
  return d.year() === dayjs().year() ? d.format('DD MMM, HH:mm') : d.format('DD MMM YYYY');
};
export const fmtDate = (v?: string | Date | null) => (v ? dayjs(v).format('DD MMM YYYY') : '—');
export const fromNow = (v?: string | Date | null) => (v ? dayjs(v).fromNow() : 'never');

export function fmtBytes(n?: number | null): string {
  if (n === undefined || n === null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export const fmtNumber = (n?: number | null) => (n ?? 0).toLocaleString('en-IN');
