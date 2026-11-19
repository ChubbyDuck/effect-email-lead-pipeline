import { ConfigProvider, Effect } from 'effect';
import { expect, test } from 'vitest';

import { FlociEndpoint } from './flociEndpoint';

const endpointFrom = (env: Record<string, string>) =>
  Effect.runSync(FlociEndpoint.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))));

test('gives no endpoint when FLOCI_ENDPOINT is not set', () => {
  expect(endpointFrom({})).toBeUndefined();
});

test('gives no endpoint when FLOCI_ENDPOINT is empty', () => {
  expect(endpointFrom({ FLOCI_ENDPOINT: '' })).toBeUndefined();
});

test('gives the endpoint of Floci when FLOCI_ENDPOINT is set', () => {
  expect(endpointFrom({ FLOCI_ENDPOINT: 'http://floci:4566' })).toBe('http://floci:4566');
});
