// IIS entry point (iisnode). IIS starts this file and hands it a named pipe in process.env.PORT.
// It loads the compiled API (apps/api/dist/server.mjs, built by `npm run build:api`), which also serves
// the admin panel. Plain JavaScript on purpose: the IIS app pool account has no user profile, so a
// TypeScript loader (tsx) cannot start under it. Plain CommonJS because iisnode loads its target with require().
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const bundle = join(__dirname, '..', 'apps', 'api', 'dist', 'server.mjs');
if (!existsSync(bundle)) {
  console.error(`MailVault API is not built: ${bundle} is missing. Run "npm run build:api" (or scripts\\install-service.ps1).`);
  process.exit(1);
}
import(pathToFileURL(bundle).href).catch((err) => {
  console.error('MailVault API failed to start:', err);
  process.exit(1);
});
