const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// Invalid on Windows plus ASCII control characters.
// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Makes an attachment or folder name safe to write on Windows:
 * strips any directory part (blocks "..\..\evil.dll"), invalid characters,
 * reserved device names and trailing dots/spaces, and limits the length.
 */
export function sanitizeFileName(input: string, maxLength = 180, fallback = 'attachment'): string {
  // Keep only the last path segment, whatever separator was used.
  const lastSegment = input.split(/[\\/]/).pop() ?? '';
  let name = lastSegment.replace(INVALID_CHARS, '_').replace(/\s+/g, ' ').trim();
  name = name.replace(/[. ]+$/g, '');
  name = name.replace(/^\.+/, '');

  if (!name) name = fallback;

  const dot = name.lastIndexOf('.');
  let base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;

  const room = Math.max(1, maxLength - ext.length);
  if (base.length > room) base = base.slice(0, room).trimEnd();

  return `${base}${ext}`;
}

/**
 * Makes one folder name safe on Windows. Unlike sanitizeFileName there is no extension:
 * "20. Orient Data" keeps its dot as text. Windows allows 255 characters per folder name;
 * 200 leaves room so long descriptive names (e.g. "…Futures and Options- Gold Silver") are kept whole.
 */
export function sanitizeFolderName(input: string, maxLength = 200, fallback = '_'): string {
  let name = input.replace(INVALID_CHARS, '_').replace(/\s+/g, ' ').trim();
  name = name.replace(/[. ]+$/g, '').replace(/^\.+/, '');
  if (!name) name = fallback;
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (name.length > maxLength) name = name.slice(0, maxLength).replace(/[. ]+$/g, '');
  return name;
}

/** Lower-case extension without the dot, or '' when there is none. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

/** "invoice.pdf" + 2 -> "invoice (2).pdf" */
export function numberedFileName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}
