// Node-only helpers (file system). Imported via "@mailvault/core/node" so the pure core stays browser-safe.
import { constants as fsc } from 'node:fs';
import { access, mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertRootExists } from './fs-root.js';

export interface FolderCheckResult {
  status: 'HEALTHY' | 'LOW_SPACE' | 'UNAVAILABLE';
  freeMb: number | null;
  error: string | null;
}

/** Exists → create if allowed → write and delete a test file → free space. */
export async function checkFolder(basePath: string, createIfMissing: boolean, lowSpaceMb: number): Promise<FolderCheckResult> {
  try {
    await assertRootExists(basePath);
    try {
      await access(basePath, fsc.F_OK);
    } catch {
      if (!createIfMissing) throw Object.assign(new Error('Folder does not exist'), { code: 'ENOENT' });
      await mkdir(basePath, { recursive: true });
    }
    const probe = join(basePath, `.mailvault-write-test-${randomUUID()}.tmp`);
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
    const s = await statfs(basePath);
    const freeMb = Math.floor((Number(s.bavail) * Number(s.bsize)) / 1024 / 1024);
    return { status: freeMb < lowSpaceMb ? 'LOW_SPACE' : 'HEALTHY', freeMb, error: null };
  } catch (err) {
    return { status: 'UNAVAILABLE', freeMb: null, error: explainFsError(err as NodeJS.ErrnoException) };
  }
}

export function explainFsError(e: NodeJS.ErrnoException): string {
  switch (e.code) {
    case 'EACCES':
    case 'EPERM':
      return 'No write permission for the account running MailVault';
    case 'ENOENT':
      return 'Path not found or network share unreachable';
    case 'ETIMEDOUT':
      return 'Network share did not respond in time';
    case 'ENOSPC':
      return 'Destination disk is full';
    case 'EBUSY':
      return 'File is locked by another program';
    case 'ENAMETOOLONG':
      return 'Path is too long';
    default:
      return e.message;
  }
}
