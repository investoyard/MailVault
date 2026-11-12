// Phase 0 check: can this account write to a destination folder (local or UNC)?
// Writes a test file the same way real downloads will: temp file → hash → rename → verify → delete.
// Usage: npm run check:share -- "\\fileserver\Finance\MailVault"
import '../env.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { explainFsError } from '@mailvault/core/node';

const target = process.argv[2];
if (!target) {
  console.error('Usage: npm run check:share -- "<D:\\path or \\\\server\\share\\path>"');
  process.exit(1);
}
if (/^[a-zA-Z]:/.test(target) && !/^[cCdD]:/.test(target)) {
  console.warn('! Mapped drive letters are not visible to Windows services. Use a UNC path (\\\\server\\share) instead.');
}

const who = `${process.env.USERDOMAIN ?? ''}\\${userInfo().username}`;
console.log(`Running as: ${who}`);

try {
  await mkdir(target, { recursive: true });
  const content = `MailVault share test ${new Date().toISOString()}`;
  const expected = createHash('sha256').update(content).digest('hex');
  const tmpDir = join(target, '.mailvault-tmp');
  await mkdir(tmpDir, { recursive: true });
  const part = join(tmpDir, `${randomUUID()}.part`);
  const final = join(target, `mailvault-share-test-${Date.now()}.txt`);

  await writeFile(part, content);
  await rename(part, final);

  const actual = await new Promise<string>((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(final).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', fail);
  });
  await rm(final, { force: true });
  await rm(tmpDir, { recursive: true, force: true });

  const s = await statfs(target);
  const freeGb = ((Number(s.bavail) * Number(s.bsize)) / 1024 ** 3).toFixed(1);
  if (actual !== expected) throw new Error('File content check failed');
  console.log(`✔ Write, rename, read-back and delete all work in ${target}`);
  console.log(`  Free space: ${freeGb} GB`);
  console.log('  Note: the Worker service must run under this same account (or one with the same share rights).');
} catch (err) {
  console.error(`✘ ${explainFsError(err as NodeJS.ErrnoException)} (${(err as Error).message})`);
  process.exit(2);
}
