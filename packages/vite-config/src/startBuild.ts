import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { createBuilder, type Plugin } from 'vite';

/**
 * A module of the client bundle that reaches a `.server` file through a plain file of the core: the client module
 * imports a plain file next to `serverModule`, and that file imports `serverModule`. Neither file is on disk.
 */
function leakOf(app: string, serverModule: string): Plugin {
  const clientModule = path.join(app, 'src', '__leak__.client.ts');
  const coreModule = path.join(path.dirname(serverModule), '__leak__.ts');
  const serverSpecifier = `./${path.basename(serverModule, path.extname(serverModule))}`;
  return {
    name: 'leak-a-server-module',
    enforce: 'pre',
    resolveId: (id) => ([clientModule, coreModule].includes(id) ? id : undefined),
    load(id) {
      if (id === clientModule) return `import * as core from ${JSON.stringify(coreModule)};\nconsole.log(core);\n`;
      if (id === coreModule) return `export * from ${JSON.stringify(serverSpecifier)};\n`;
      return undefined;
    },
    transform(code, id) {
      if (id === path.join(app, 'src', 'router.tsx')) return `import ${JSON.stringify(clientModule)};\n${code}`;
      return undefined;
    },
  };
}

/**
 * Builds the TanStack Start web app in the folder `app` into `outDir`, with the Vite config of the app. `leak` adds a
 * client module that reaches this `.server` file through a plain file of the core. Returns the text of the client
 * bundle.
 */
export async function buildStartApp(app: string, outDir: string, leak?: { readonly serverModule: string }) {
  const builder = await createBuilder({
    configFile: path.join(app, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir },
    plugins: leak === undefined ? [] : [leakOf(app, leak.serverModule)],
  });
  await builder.buildApp();
  const clientDir = path.join(outDir, 'client');
  const files = await readdir(clientDir, { recursive: true });
  const scripts = files.filter((file) => file.endsWith('.js'));
  const texts = await Promise.all(scripts.map((file) => readFile(path.join(clientDir, file), 'utf8')));
  return texts.join('\n');
}
