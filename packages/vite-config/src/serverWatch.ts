/**
 * Paths Vite should not watch during app/storybook dev.
 * Prevents HMR / SSR reloads when editing docs, specs, and tests.
 *
 * Vitest sets `VITEST` and needs to watch test files, so ignores are reduced there.
 */
export const nonSourceWatchIgnored = [
  '**/*.md',
  '**/*.mdx',
  '**/*.{test,spec}.{ts,tsx,js,jsx}',
  '**/*.stories.{ts,tsx,js,jsx}',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/coverage/**',
  '**/.agents/**',
  '**/docs/**',
] as const;

export type ServerWatchOptions = {
  ignored: string[];
};

export function getServerWatchOptions(options?: {
  /** Keep watching Storybook story modules (default: ignore them). */
  watchStories?: boolean;
}): ServerWatchOptions {
  if (process.env.VITEST) {
    return { ignored: ['**/coverage/**'] };
  }

  const ignored = options?.watchStories
    ? nonSourceWatchIgnored.filter((pattern) => !pattern.includes('*.stories.'))
    : [...nonSourceWatchIgnored];

  return { ignored };
}
