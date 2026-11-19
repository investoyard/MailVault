// Server-side folder browser for the destination picker. Lists folder NAMES only (never files),
// hides Windows system locations, and can be limited to admin-chosen roots.
import { mkdir, readdir, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { sanitizeFileName } from '../filename.js';
import { assertRootExists } from './fs-root.js';
import { checkFolder, explainFsError, type FolderCheckResult } from './folder-check.js';

export interface FolderEntry {
  name: string;
  path: string;
}

export interface FolderListing {
  /** null = the top level (drives, or the configured roots). */
  path: string | null;
  /** Folder to go "up" to; null = back to the top level. */
  parent: string | null;
  folders: FolderEntry[];
  truncated: boolean;
}

/** A request the destination picker sends to the worker (queue "folder-ops"). */
export type FolderOp =
  | { op: 'browse'; path?: string | null }
  | { op: 'test'; path: string; createIfMissing: boolean; lowSpaceThresholdMb: number }
  | { op: 'mkdir'; parent: string; name: string };

export type FolderOpResult =
  | { ok: true; account: string; listing?: FolderListing; check?: FolderCheckResult; created?: string }
  | { ok: false; account: string; error: string };

const MAX_ENTRIES = 1000;

/** Windows account this process runs as, e.g. "FINWAVE\svc-mailvault" or "NT AUTHORITY\SYSTEM". */
export function processAccount(): string {
  const user = userInfo().username;
  if (/^(SYSTEM|.+\$)$/i.test(user)) return 'NT AUTHORITY\\SYSTEM';
  const domain = process.env.USERDOMAIN;
  return domain && domain.toLowerCase() !== hostname().toLowerCase() ? `${domain}\\${user}` : `${hostname()}\\${user}`;
}

/**
 * Trims, converts / to \, resolves "." and "..", and drops a trailing backslash (except on
 * D:\ and \\server\share\). Throws for anything that is not a local or UNC path.
 */
export function normalizeFolderPath(input: string): string {
  const raw = input.trim().replace(/\//g, '\\');
  if (!/^[a-zA-Z]:\\/.test(raw) && !/^[a-zA-Z]:$/.test(raw) && !/^\\\\[^\\]+\\[^\\]+/.test(raw)) {
    throw new Error('Use a local path (D:\\...) or a network share (\\\\server\\share\\...)');
  }
  let p = win32.normalize(/^[a-zA-Z]:$/.test(raw) ? `${raw}\\` : raw);
  const root = win32.parse(p).root;
  if (p.length > root.length) p = p.replace(/\\+$/, '');
  if (/^[a-z]:/.test(p)) p = p[0]!.toUpperCase() + p.slice(1);
  return p;
}

const lower = (p: string) => p.toLowerCase().replace(/\\+$/, '');

/** True when `p` is `root` or inside it (case-insensitive, whole path segments). */
export function isInside(p: string, root: string): boolean {
  const a = lower(p);
  const b = lower(root);
  return a === b || a.startsWith(`${b}\\`);
}

/** Windows system locations that are never shown or accepted as destinations. */
export function blockedLocations(env: NodeJS.ProcessEnv = process.env): string[] {
  const sysDrive = env.SystemDrive || 'C:';
  return [
    env.SystemRoot || `${sysDrive}\\Windows`,
    env.ProgramFiles || `${sysDrive}\\Program Files`,
    env['ProgramFiles(x86)'] || `${sysDrive}\\Program Files (x86)`,
    env.ProgramData || `${sysDrive}\\ProgramData`,
    `${sysDrive}\\Users`,
    `${sysDrive}\\Recovery`,
    `${sysDrive}\\Boot`,
  ];
}

const HIDDEN_NAME = /^(\$|\.)|^(System Volume Information|Recovery|Config\.Msi|Documents and Settings|PerfLogs)$/i;

export function isBlocked(p: string, blocked = blockedLocations()): boolean {
  if (blocked.some((b) => isInside(p, b))) return true;
  // Any hidden/system segment along the way ($Recycle.Bin, .mailvault-tmp, System Volume Information, ...).
  const segments = p.replace(/^\\\\/, '').split('\\').slice(1);
  return segments.some((s) => HIDDEN_NAME.test(s));
}

/** Throws a readable error when the path is a system folder or outside the allowed roots. */
export function assertAllowed(p: string, roots: string[], blocked = blockedLocations()): void {
  if (isBlocked(p, blocked)) throw new Error('This is a Windows system folder and cannot be used');
  if (roots.length && !roots.some((r) => isInside(p, normalizeFolderPath(r)))) {
    throw new Error(`Only folders inside these locations are allowed: ${roots.join(', ')}`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(`${what} did not respond in time`), { code: 'ETIMEDOUT' })), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await withTimeout(stat(p), 3_000, p)).isDirectory();
  } catch {
    return false;
  }
}

/** Local drives that are present (C: to Z:). */
export async function listDrives(): Promise<FolderEntry[]> {
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(letters.map(async (l) => ((await exists(`${l}:\\`)) ? l : null)));
  return found.filter((l): l is string => !!l).map((l) => ({ name: `${l}:`, path: `${l}:\\` }));
}

export async function browseFolders(path: string | null | undefined, roots: string[] = []): Promise<FolderListing> {
  const normRoots = roots.map(normalizeFolderPath);
  if (!path?.trim()) {
    const folders = normRoots.length ? normRoots.map((r) => ({ name: r, path: r })) : await listDrives();
    return { path: null, parent: null, folders, truncated: false };
  }

  const p = normalizeFolderPath(path);
  assertAllowed(p, normRoots);
  await assertRootExists(p);
  const entries = await withTimeout(readdir(p, { withFileTypes: true }), 15_000, 'The folder');
  const blocked = blockedLocations();
  const folders = entries
    // Junctions/symlinks (isSymbolicLink) are skipped: they point elsewhere and often loop.
    .filter((e) => e.isDirectory() && !HIDDEN_NAME.test(e.name))
    .map((e) => ({ name: e.name, path: win32.join(p, e.name) }))
    .filter((f) => !isBlocked(f.path, blocked))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  // At a drive/share root or at a configured root, "up" goes back to the top-level list.
  const atTop = lower(p) === lower(win32.parse(p).root) || normRoots.some((r) => lower(r) === lower(p));
  const parent = atTop ? null : win32.dirname(p);
  return { path: p, parent, folders: folders.slice(0, MAX_ENTRIES), truncated: folders.length > MAX_ENTRIES };
}

/** Creates one new sub-folder; returns its full path. */
export async function createSubfolder(parent: string, name: string, roots: string[] = []): Promise<string> {
  const p = normalizeFolderPath(parent);
  const clean = sanitizeFileName(name.trim(), 120, '');
  if (!clean || clean !== name.trim()) throw new Error('Folder names cannot contain \\ / : * ? " < > | or end with a dot or space');
  const target = win32.join(p, clean);
  assertAllowed(target, roots.map(normalizeFolderPath));
  await assertRootExists(target);
  try {
    await mkdir(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A folder with that name already exists');
    throw err;
  }
  return target;
}

/** Runs one picker request. Never throws: errors come back as readable messages. */
export async function runFolderOp(op: FolderOp, roots: string[] = []): Promise<FolderOpResult> {
  const account = processAccount();
  try {
    switch (op.op) {
      case 'browse':
        return { ok: true, account, listing: await browseFolders(op.path, roots) };
      case 'test': {
        const p = normalizeFolderPath(op.path);
        assertAllowed(p, roots.map(normalizeFolderPath));
        return { ok: true, account, check: await checkFolder(p, op.createIfMissing, op.lowSpaceThresholdMb) };
      }
      case 'mkdir':
        return { ok: true, account, created: await createSubfolder(op.parent, op.name, roots) };
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { ok: false, account, error: e.code ? explainFsError(e) : e.message };
  }
}
