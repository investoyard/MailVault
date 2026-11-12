import { checkFolder } from '@mailvault/core/node';
import { prisma } from '@mailvault/db';
import { log } from '../env.js';
import { raiseAlert, resolveAlert } from '../pipeline/alerts.js';

/**
 * Checks every destination folder. Alerts only when the state changes
 * (healthy → unavailable, and again on recovery), never on every run.
 * Downloads waiting for a recovered folder are released immediately.
 */
export async function runFolderHealth() {
  const destinations = await prisma.destination.findMany();
  for (const d of destinations) {
    const r = await checkFolder(d.basePath, d.createIfMissing, d.lowSpaceThresholdMb);
    await prisma.destination.update({
      where: { id: d.id },
      data: {
        status: r.status,
        freeSpaceMb: r.freeMb !== null ? BigInt(r.freeMb) : null,
        lastError: r.error,
        lastCheckedAt: new Date(),
      },
    });

    const key = `DESTINATION:${d.id}`;
    if (r.status === 'UNAVAILABLE' && d.status !== 'UNAVAILABLE') {
      log.warn({ destination: d.name, error: r.error }, 'destination unavailable');
      await raiseAlert({ key, type: 'DESTINATION_UNAVAILABLE', severity: 'ERROR', title: `Folder unavailable: ${d.name}`, message: `${d.basePath}: ${r.error}`, link: '/destinations' });
    }
    const spaceKey = `DESTINATION_SPACE:${d.id}`;
    if (r.status === 'LOW_SPACE' && d.status !== 'LOW_SPACE') {
      await raiseAlert({
        key: spaceKey,
        type: 'DESTINATION_LOW_SPACE',
        severity: 'WARNING',
        title: `Low disk space: ${d.name}`,
        message: `${d.basePath} has ${r.freeMb} MB free (warning below ${d.lowSpaceThresholdMb} MB).`,
        link: '/destinations',
      });
    } else if (r.status === 'HEALTHY' && d.status === 'LOW_SPACE') {
      await resolveAlert(spaceKey, `Disk space OK again: ${d.name}`, d.basePath, '/destinations');
    }
    if (r.status !== 'UNAVAILABLE' && d.status === 'UNAVAILABLE') {
      log.info({ destination: d.name }, 'destination recovered');
      await resolveAlert(key, `Folder available again: ${d.name}`, d.basePath, '/destinations');
      await prisma.attachmentDownload.updateMany({
        where: { status: 'WAITING_DESTINATION', match: { rule: { destinationId: d.id } } },
        data: { nextAttemptAt: new Date() },
      });
    }
  }
}
