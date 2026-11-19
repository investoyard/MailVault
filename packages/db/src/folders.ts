import { prisma } from './index.js';

/**
 * Locations the destination picker may show (Settings → Destination folders). Empty = every
 * local drive, except Windows system folders.
 */
export async function browseRoots(): Promise<string[]> {
  const row = await prisma.setting.findUnique({ where: { key: 'destinations.browseRoots' } });
  return Array.isArray(row?.value) ? row.value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}
