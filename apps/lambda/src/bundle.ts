import path from 'node:path';

/** The folders of the Lambda bundles: one subfolder for each handler (`inbox`, `leadSources`, `leads`). */
export const lambdaBundle = {
  /** `build` writes the handlers of a real deployment here. */
  live: path.resolve(import.meta.dirname, '../dist'),
  /** `build:e2e` writes the handlers of the e2e suite here, with the `LambdaE2E` composition root. */
  e2e: path.resolve(import.meta.dirname, '../dist-e2e'),
};
