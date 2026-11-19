import { reactWithCompiler } from '@leads/vite-config/reactCompilerOxc';
import { getServerWatchOptions } from '@leads/vite-config/serverWatch';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vite';

/**
 * The orders dashboard: a local page of the orders that the lead handler stored. It is a TanStack Start app with its
 * own hexagon in `src`: the Orders core, its adapter, and the Dashboard entry points (the server function and the
 * composition root). `PORT` selects the port (default 4790). It listens only on the loopback address,
 * because the orders hold contact data and the page has no login.
 */
export default defineConfig({
  root: import.meta.dirname,
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? 4790),
    strictPort: true,
    watch: getServerWatchOptions(),
  },
  plugins: [
    tailwindcss(),
    // The import protection checks the importers in `src`: the UI and the hexagon of the app. A plain file of the core
    // that imports a `.server` file would give it to the client bundle. `build.test.ts` guards this.
    tanstackStart({ importProtection: { include: ['src/**'] } }),
    reactWithCompiler(),
  ],
});
