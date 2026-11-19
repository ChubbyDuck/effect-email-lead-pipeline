import { ConfigProvider, Effect } from 'effect';
import { expect, test } from 'vitest';

import { E2EBucketName, E2EBucketNotSet, E2EFlociEndpoint } from './config';

const withEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

test('uses the Floci of the Compose network when FLOCI_ENDPOINT is not set or empty', () => {
  expect(Effect.runSync(E2EFlociEndpoint.pipe(withEnv({})))).toBe('http://floci:4566');
  expect(Effect.runSync(E2EFlociEndpoint.pipe(withEnv({ FLOCI_ENDPOINT: '' })))).toBe('http://floci:4566');
});

test('uses the endpoint of FLOCI_ENDPOINT when it is set', () => {
  expect(Effect.runSync(E2EFlociEndpoint.pipe(withEnv({ FLOCI_ENDPOINT: 'http://127.0.0.1:4566' })))).toBe(
    'http://127.0.0.1:4566'
  );
});

test('reads the observation bucket from E2E_BUCKET_NAME', () => {
  expect(Effect.runSync(E2EBucketName.pipe(withEnv({ E2E_BUCKET_NAME: 'leads-e2e' })))).toBe('leads-e2e');
});

test('fails with a clear message when E2E_BUCKET_NAME is not set or empty', () => {
  for (const env of [{}, { E2E_BUCKET_NAME: '' }]) {
    const error = Effect.runSync(E2EBucketName.pipe(withEnv(env), Effect.flip));

    expect(error).toBeInstanceOf(E2EBucketNotSet);
    expect(error.message).toContain('Missing E2E observation bucket (E2E_BUCKET_NAME)');
    expect(error.reason).toMatchObject({ _tag: 'ConfigError' });
  }
});
