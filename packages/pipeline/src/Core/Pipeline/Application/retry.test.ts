import { Clock, Effect, Fiber, Random } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, test } from 'vitest';

import { maxRetryDelay, retryPolicy } from './retry';

/** Fails each attempt and returns the times of the attempts and the time of the end, with the clock in ms from 0. */
const timesOf = (policy: Effect.Retry.Options<string>) =>
  Effect.gen(function* () {
    const attempts: number[] = [];
    const failing = Clock.currentTimeMillis.pipe(
      Effect.tap((now) => Effect.sync(() => attempts.push(now))),
      Effect.andThen(Effect.fail('failed'))
    );
    const end = yield* failing.pipe(
      Effect.retry(policy),
      Effect.exit,
      Effect.andThen(Clock.currentTimeMillis),
      Effect.forkChild
    );
    yield* TestClock.adjust('5 minutes');
    return { attempts, end: yield* Fiber.join(end) };
  });

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())));

const waitsOf = (attempts: readonly number[]) => attempts.slice(1).map((time, index) => time - attempts[index]!);

describe('retryPolicy', () => {
  const policy = retryPolicy({ leadProcessingRetry: 7, leadProcessingRetryDelay: 200 });

  test('doubles each wait up to the longest wait, and the jitter keeps each wait within 20%', async () => {
    const { attempts } = await run(timesOf(policy));

    expect(attempts).toHaveLength(8);
    const expected = [200, 400, 800, 1_600, maxRetryDelay, maxRetryDelay, maxRetryDelay];
    for (const [index, wait] of waitsOf(attempts).entries()) {
      expect(wait).toBeGreaterThanOrEqual(expected[index]! * 0.8);
      expect(wait).toBeLessThanOrEqual(expected[index]! * 1.2);
    }
  });

  test('gives different waits to handlers that fail at the same time', async () => {
    const handlers = ['a', 'b', 'c', 'd', 'e'].map((seed) => timesOf(policy).pipe(Random.withSeed(seed)));

    const results = await Promise.all(handlers.map(run));

    const firstRetries = results.map(({ attempts }) => attempts[1]);
    expect(new Set(firstRetries).size).toBe(handlers.length);
  });

  test('does not wait after the last attempt', async () => {
    const { attempts, end } = await run(
      timesOf(retryPolicy({ leadProcessingRetry: 2, leadProcessingRetryDelay: 200 }))
    );

    expect(attempts).toHaveLength(3);
    expect(end).toBe(attempts.at(-1));
  });

  test('does not wait for an error that `while` does not retry', async () => {
    const { attempts, end } = await run(timesOf({ ...policy, while: () => false }));

    expect(attempts).toEqual([0]);
    expect(end).toBe(0);
  });

  test('makes no retry when the policy has no retries', async () => {
    const { attempts } = await run(timesOf(retryPolicy({ leadProcessingRetry: 0, leadProcessingRetryDelay: 200 })));

    expect(attempts).toEqual([0]);
  });
});
