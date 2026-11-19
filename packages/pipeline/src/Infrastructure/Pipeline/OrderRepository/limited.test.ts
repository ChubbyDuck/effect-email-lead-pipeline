import { orderWritesPerSecond } from '@leads/shared/domain/orderWrites';
import { Lead } from '@leads/shared/domain/types';
import { Clock, Effect, Fiber, Layer, Schema } from 'effect';
import { RateLimiter } from 'effect/persistence';
import { TestClock } from 'effect/testing';
import { expect, test } from 'vitest';

import { OrderRepository, OrderStoreFailed } from '#Core/Pipeline/Ports/OrderRepository';

import { withOrderWriteLimit } from './limited';

const lead = (idempotencyKey: string) =>
  Schema.decodeSync(Lead)({
    extraction_source: 'new_acquisition',
    idempotencyKey,
    extracted: { name: 'Acme' },
    raw: { Name: 'Acme' },
  });

/** A repository that records the time of each store, from the Effect clock. */
function recorder() {
  const stored: number[] = [];
  const layer = Layer.succeed(OrderRepository, {
    store: () =>
      Clock.currentTimeMillis.pipe(
        Effect.map((millis) => {
          stored.push(millis);
        })
      ),
  });
  return { stored, layer };
}

const memoryLimiter = () => Effect.runSync(RateLimiter.make.pipe(Effect.provide(RateLimiter.layerStoreMemory)));

test('stores the writes of one second at once and makes the next store wait for its token', async () => {
  const { stored, layer } = recorder();
  const leads = Array.from({ length: orderWritesPerSecond.environment + 1 }, (_, index) => lead(`key-${index}`));

  await Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* OrderRepository;
      const fiber = yield* Effect.forkChild(
        Effect.forEach(leads, (each) => repository.store(each), { concurrency: 'unbounded' })
      );
      yield* TestClock.adjust('99 millis');
      expect(stored).toHaveLength(orderWritesPerSecond.environment);
      yield* TestClock.adjust('1 millis');
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide([layer.pipe(withOrderWriteLimit(memoryLimiter())), TestClock.layer()]))
  );

  expect(stored).toEqual([...Array.from({ length: orderWritesPerSecond.environment }, () => 0), 100]);
});

test('keeps the bucket of one limiter from one build of the layer to the next', async () => {
  const { stored, layer } = recorder();
  const limiter = memoryLimiter();
  const invocation = (keys: readonly string[]) =>
    Effect.gen(function* () {
      const repository = yield* OrderRepository;
      yield* Effect.forEach(keys, (key) => repository.store(lead(key)), { concurrency: 'unbounded' });
    }).pipe(Effect.provide(layer.pipe(withOrderWriteLimit(limiter))));

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* invocation(Array.from({ length: orderWritesPerSecond.environment }, (_, index) => `first-${index}`));
      const second = yield* Effect.forkChild(invocation(['second']));
      yield* TestClock.adjust('99 millis');
      expect(stored).toHaveLength(orderWritesPerSecond.environment);
      yield* TestClock.adjust('1 millis');
      yield* Fiber.join(second);
    }).pipe(Effect.provide(TestClock.layer()))
  );

  expect(stored).toHaveLength(orderWritesPerSecond.environment + 1);
  expect(stored.at(-1)).toBe(100);
});

test('keeps a failure of the limiter as the reason of OrderStoreFailed', async () => {
  const { stored, layer } = recorder();
  const reason = new Error('store down');
  const limiter = { consume: () => Effect.fail(reason) } as unknown as RateLimiter.RateLimiter;

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* OrderRepository;
      return yield* Effect.result(repository.store(lead('key')));
    }).pipe(Effect.provide(layer.pipe(withOrderWriteLimit(limiter))))
  );

  expect(result._tag).toBe('Failure');
  if (result._tag !== 'Failure') return;
  expect(result.failure).toBeInstanceOf(OrderStoreFailed);
  expect(result.failure.reason).toBe(reason);
  expect(stored).toHaveLength(0);
});
