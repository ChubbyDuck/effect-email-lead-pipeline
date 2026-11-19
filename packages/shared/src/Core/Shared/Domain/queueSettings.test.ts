import { expect, test } from 'vitest';

import { visibilityTimeout } from './queueSettings';

test('gives a queue the batching window, one invocation, and a margin of 30 s', () => {
  expect(visibilityTimeout(60_000)).toBe(90_000);
  expect(visibilityTimeout(60_000, 10_000)).toBe(100_000);
});
