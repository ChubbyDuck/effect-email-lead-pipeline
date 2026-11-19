import { configDefaults, defineConfig, type ViteUserConfig } from 'vitest/config';

const integration = process.env.VITEST_INTEGRATION === '1';
const e2e = process.env.VITEST_E2E === '1';

/**
 * The common Vitest settings of a package. A plain run takes the unit tests. `VITEST_INTEGRATION=1` takes only the
 * `*.integration.test.ts` files (Floci on `FLOCI_ENDPOINT`), and `VITEST_E2E=1` takes only the `*.e2e.test.ts` files.
 * `test` adds settings of the package, such as a longer timeout.
 */
export function leadsTestConfig(test: NonNullable<ViteUserConfig['test']> = {}) {
  return defineConfig({
    test: {
      include: e2e
        ? ['src/**/*.e2e.test.ts']
        : integration
          ? ['src/**/*.integration.test.ts']
          : ['src/**/*.test.{ts,tsx}', '*.test.ts'],
      exclude: [
        ...configDefaults.exclude,
        ...(integration || e2e ? [] : ['**/*.integration.test.ts', '**/*.e2e.test.ts']),
      ],
      ...(e2e && { testTimeout: 90_000, hookTimeout: 90_000, fileParallelism: false }),
      passWithNoTests: !e2e,
      ...test,
    },
  });
}
