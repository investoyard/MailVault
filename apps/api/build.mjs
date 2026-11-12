// Compiles the API (and the @mailvault/* workspace packages it uses) to one plain JavaScript file:
//   apps/api/dist/server.mjs
// IIS (iisnode) runs this file, so no TypeScript loader is needed at runtime. Third-party packages stay in
// node_modules (not bundled). The output sits at the same folder depth as src/, so paths like
// ROOT = '../../..' keep pointing at the repository root.
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(here, 'dist/server.mjs');
await rm(resolve(here, 'dist'), { recursive: true, force: true });

await build({
  entryPoints: [resolve(here, 'src/server.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: 'linked',
  logLevel: 'warning',
  // Keep real npm packages external; bundle only our own TypeScript workspace packages.
  plugins: [
    {
      name: 'externalize-npm-packages',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.kind === 'entry-point' || /^[A-Za-z]:[\\/]/.test(args.path)) return undefined; // our files (Windows paths)
          if (args.path.startsWith('@mailvault/')) return undefined; // bundle our workspace code
          if (args.path.startsWith('node:')) return { path: args.path, external: true };
          return { path: args.path, external: true };
        });
      },
    },
  ],
  // ESM output: provide require() for any CommonJS-only code paths.
  banner: { js: "import { createRequire as __mvCreateRequire } from 'node:module'; const require = __mvCreateRequire(import.meta.url);" },
});

console.log(`Built ${outfile}`);
