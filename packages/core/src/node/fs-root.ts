import { stat } from 'node:fs/promises';
import { parse } from 'node:path';

/**
 * Throws ENOENT when the drive (D:\) or network share (\\server\share) itself is missing.
 * Needed because a recursive mkdir under a missing Windows drive/share can hang instead of failing.
 */
export async function assertRootExists(path: string): Promise<void> {
  const root = parse(path).root;
  if (!root) return;
  try {
    await withTimeout(stat(root), 15_000);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw Object.assign(new Error(`Drive or network share not reachable: ${root}`), { code: e.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'ENOENT' });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
