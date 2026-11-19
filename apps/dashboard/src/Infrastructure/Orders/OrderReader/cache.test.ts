import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, test } from 'vitest';

import type { OrderRead } from '#Core/Orders/Domain/order';
import { OrderReader, OrdersNotRead } from '#Core/Orders/Ports/OrderReader';

import { makeOrderCache } from './cache';

/** A reader that gives a new read on each call, or fails when the test says so. */
function reader() {
  const state = { reads: 0, failing: false };
  const service = OrderReader.of({
    all: Effect.suspend(() => {
      state.reads += 1;
      if (state.failing) return Effect.fail(new OrdersNotRead({ reason: 'unavailable', authentication: false }));
      return Effect.succeed<OrderRead>({ orders: [], readAt: `read ${state.reads}` });
    }),
  });
  return { state, service };
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())));

test('keeps a read for 10 seconds, then reads again', async () => {
  const { state, service } = reader();

  const reads = await run(
    Effect.gen(function* () {
      const cache = yield* makeOrderCache(service, '10 seconds');
      const first = yield* cache.cached.all;
      yield* TestClock.adjust('9 seconds');
      const kept = yield* cache.cached.all;
      yield* TestClock.adjust('1 second');
      const next = yield* cache.cached.all;
      return [first.readAt, kept.readAt, next.readAt];
    })
  );

  expect(reads).toEqual(['read 1', 'read 1', 'read 2']);
  expect(state.reads).toBe(2);
});

test('does not keep a read that failed', async () => {
  const { state, service } = reader();

  const reads = await run(
    Effect.gen(function* () {
      const cache = yield* makeOrderCache(service, '10 seconds');
      state.failing = true;
      const failed = yield* Effect.result(cache.cached.all);
      state.failing = false;
      const next = yield* cache.cached.all;
      return [failed._tag, next.readAt];
    })
  );

  expect(reads).toEqual(['Failure', 'read 2']);
});

test('a fresh read skips the cache and keeps its result for the next reads', async () => {
  const { service } = reader();

  const reads = await run(
    Effect.gen(function* () {
      const cache = yield* makeOrderCache(service, '10 seconds');
      const first = yield* cache.cached.all;
      const fresh = yield* cache.fresh.all;
      const kept = yield* cache.cached.all;
      return [first.readAt, fresh.readAt, kept.readAt];
    })
  );

  expect(reads).toEqual(['read 1', 'read 2', 'read 2']);
});
