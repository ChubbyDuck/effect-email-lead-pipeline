import { Config, Data, Effect } from 'effect';

import { FlociEndpoint } from '#Entrypoints/Lambda/flociEndpoint';

/** The e2e bundle runs only in Floci. Without `FLOCI_ENDPOINT`, it uses the Floci of the Compose network. */
export const E2EFlociEndpoint = FlociEndpoint.pipe(Config.map((endpoint) => endpoint ?? 'http://floci:4566'));

/** Read one time for each execution environment: the AWS clients at module scope take it. */
export const e2eFlociEndpoint = Effect.runSync(E2EFlociEndpoint);

export class E2EBucketNotSet extends Data.TaggedError('E2EBucketNotSet')<{ readonly reason: unknown }> {
  override get message(): string {
    // A ConfigError is not an Error, so withReason cannot show it.
    return `Missing E2E observation bucket (E2E_BUCKET_NAME): ${String(this.reason)}`;
  }
}

/** The bucket that holds the observations of the e2e suite. */
export const E2EBucketName = Config.NonEmptyString('E2E_BUCKET_NAME').pipe(
  Effect.mapError((reason) => new E2EBucketNotSet({ reason }))
);

/**
 * Read at each observation, not at module scope: a missing bucket name fails the observation with a clear message, not
 * the import of the bundle.
 */
export const e2eBucketName = () => Effect.runSync(E2EBucketName);
