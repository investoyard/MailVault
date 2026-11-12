// Phase 0 check: can the app read a mailbox through Microsoft Graph?
// Usage: npm run check:graph -- accounts@company.com
import '../env.js';
import { M365Provider, graphConfigFromEnv } from '@mailvault/m365';

const mailbox = process.argv[2];
if (!mailbox) {
  console.error('Usage: npm run check:graph -- <mailbox@company.com>');
  process.exit(1);
}

try {
  const cfg = graphConfigFromEnv();
  console.log(`Tenant ${cfg.tenantId}, app ${cfg.clientId}, auth: ${cfg.certPath ? 'certificate' : 'client secret'}`);
  const result = await new M365Provider(cfg).testConnection(mailbox);
  if (result.ok) {
    console.log(`✔ Connected to ${mailbox} in ${result.latencyMs} ms`);
    console.log(`  Folders: ${result.folderCount}`);
    console.log(`  Newest Inbox email: ${result.sampleMessageSubject}`);
    process.exit(0);
  }
  console.error(`✘ ${result.error}`);
  process.exit(2);
} catch (err) {
  console.error(`✘ ${(err as Error).message}`);
  process.exit(2);
}
