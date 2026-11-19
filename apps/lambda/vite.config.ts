import { defineConfig } from 'vite';

const entries: Record<string, string> = {
  inbox: 'src/Entrypoints/Lambda/inbox.ts',
  leadSources: 'src/Entrypoints/Lambda/leadSources.ts',
  leads: 'src/Entrypoints/Lambda/leads.ts',
};

export default defineConfig(({ mode }) => {
  const entry = entries[mode];
  if (!entry) throw new Error(`Unknown Lambda entry: ${mode}`);

  return {
    ssr: { target: 'node', noExternal: true },
    build: {
      ssr: entry,
      target: 'node24',
      outDir: `dist/${mode}`,
      emptyOutDir: true,
      copyPublicDir: false,
      rolldownOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.js',
          codeSplitting: false,
        },
      },
    },
  };
});
