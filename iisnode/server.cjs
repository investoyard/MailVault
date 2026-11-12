// IIS entry point (iisnode). IIS starts this file and hands it a named pipe in process.env.PORT.
// It registers the tsx loader (so the TypeScript API runs as-is, like `npm run start:api`) and loads the API.
// Plain CommonJS on purpose: iisnode loads its target with require().
const { register } = require('tsx/esm/api');

register();
import('../apps/api/src/server.ts').catch((err) => {
  console.error('MailVault API failed to start:', err);
  process.exit(1);
});
