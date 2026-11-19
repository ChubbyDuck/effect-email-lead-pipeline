import { reactWithCompiler } from '@leads/vite-config/reactCompilerOxc';
import { getServerWatchOptions } from '@leads/vite-config/serverWatch';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vite';

/**
 * The lab: a local page of the deployed pipeline as it runs, and the burst simulator. It is a TanStack Start app with
 * its own hexagon in `src`: the Observation and Simulation core, their adapters, and the Lab entry points (the server
 * functions, the body of the request stream, and the composition root). `PORT` selects the port (default 4780).
 */
export default defineConfig({
  root: import.meta.dirname,
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? 4780),
    strictPort: true,
    watch: getServerWatchOptions(),
  },
  optimizeDeps: {
    // Only the server reads the Alchemy state (`alchemyState.server.ts`). The scan of the client finds the import all
    // the same, and the browser build of its AWS client lacks the credential providers, so the scan fails.
    exclude: ['@alchemy.run/aws'],
  },
  plugins: [
    tailwindcss(),
    // The import protection checks the importers in `src`: the UI and the hexagon of the app. A plain file of the core
    // that imports a `.server` file would give it to the client bundle. `build.test.ts` guards this.
    tanstackStart({ importProtection: { include: ['src/**'] } }),
    reactWithCompiler(),
  ],
});
