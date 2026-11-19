import { rm } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'vite';

// Builds the handlers of the e2e suite into `dist-e2e/<handler>`: the same handlers, with the `LambdaE2E` composition
// root in place of `Entrypoints/Lambda/services`.
const root = import.meta.dirname;
const e2e = path.join(root, 'src/Entrypoints/LambdaE2E');
await rm(path.join(root, 'dist-e2e'), { recursive: true, force: true });
for (const name of ['inbox', 'leadSources', 'leads']) {
  let replacements = 0;
  await build({
    root,
    configFile: false,
    plugins: [
      {
        name: 'e2e-driven-adapters',
        enforce: 'pre',
        resolveId(source, importer) {
          if (!importer?.includes('/src/Entrypoints/Lambda/')) return;
          if (source === './services') {
            replacements++;
            return path.join(e2e, 'services.ts');
          }
          if (source === './leadSourcesServices') {
            replacements++;
            return path.join(e2e, 'leadSourcesServices.ts');
          }
        },
      },
    ],
    ssr: { target: 'node', noExternal: true },
    build: {
      ssr: path.join(e2e, `${name}.ts`),
      target: 'node24',
      outDir: path.join(root, 'dist-e2e', name),
      emptyOutDir: true,
      copyPublicDir: false,
      rolldownOptions: { output: { format: 'cjs', entryFileNames: 'index.js', codeSplitting: false } },
    },
  });
  if (replacements !== 1)
    throw new Error(`${name}: expected exactly one test service replacement, received ${replacements}`);
}
