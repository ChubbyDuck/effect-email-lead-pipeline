// Builds one bundle for each handler into `dist/<handler>`. `@leads/cdk` deploys them (see `src/bundle.ts`).
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'vite';

const root = import.meta.dirname;
await rm(path.join(root, 'dist'), { recursive: true, force: true });

for (const name of ['inbox', 'leadSources', 'leads']) {
  await build({ root, configFile: path.join(root, 'vite.config.ts'), mode: name });
}
