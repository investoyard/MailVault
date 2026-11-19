// Default settings. Run: npm run db:seed
import './load-env.js';
import { DEFAULT_BLOCKED_EXTENSIONS } from '@mailvault/shared';
import { prisma } from './index.js';

const defaults: Record<string, unknown> = {
  'sync.intervalMinutes': 5,
  'retry.maxAttempts': 5,
  'retry.intervalsMinutes': [1, 5, 15, 60],
  'attachments.maxSizeMb': 150,
  'attachments.blockedExtensions': DEFAULT_BLOCKED_EXTENSIONS,
  'attachments.includeInline': false,
  'files.defaultDuplicatePolicy': 'SMART',
  'files.defaultDestinationId': null,
  'general.businessTimeZone': 'Asia/Kolkata',
  'general.initialLookbackDays': 0,
  'logs.retentionDays': 90,
  'history.retentionDays': 730,
  'logs.autoCleanup': true,
  'notifications.dailyDigest': true,
  'notifications.smtp': { enabled: false, host: '', port: 587, secure: false, user: '', from: '' },
  'notifications.teams.enabled': false,
  'destinations.browseRoots': [],
};

async function main() {
  for (const [key, value] of Object.entries(defaults)) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: {},
    });
  }
  console.log(`Seeded ${Object.keys(defaults).length} default settings.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
