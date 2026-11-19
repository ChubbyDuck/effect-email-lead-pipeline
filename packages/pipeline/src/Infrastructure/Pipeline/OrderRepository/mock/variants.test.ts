import { Lead } from '@leads/shared/domain/types';
import { Effect, Exit, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, test } from 'vitest';

import { OrderRepository } from '#Core/Pipeline/Ports/OrderRepository';

import { makeOrderRepository, orderRepositoryBuilder } from './variants';

const lead = (name: string) =>
  Schema.decodeSync(Lead)({
    extraction_source: 'new_acquisition',
    idempotencyKey: 'key',
    extracted: { name },
    raw: { Name: name },
  });

test('followsLeadScripts counts attempts per lead, not per call', async () => {
  const orderRepository = makeOrderRepository(orderRepositoryBuilder.store('followsLeadScripts'));
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const service = yield* OrderRepository;
      yield* Effect.exit(service.store(lead('Broken')));
      yield* Effect.exit(service.store(lead('Broken')));
      yield* Effect.forkChild(service.store(lead('Flaky')));
      yield* TestClock.adjust('1 second');
    }).pipe(Effect.provide([orderRepository.layer, TestClock.layer()]))
  );

  expect(Exit.isSuccess(exit)).toBe(true);
  expect(
    orderRepository.observation.attempts.map(({ lead, attempt, outcome }) => ({ lead, attempt, outcome }))
  ).toEqual([
    { lead: 'Broken', attempt: 1, outcome: 'OrderStoreFailed' },
    { lead: 'Broken', attempt: 2, outcome: 'OrderStoreFailed' },
    { lead: 'Flaky', attempt: 1, outcome: 'OrderStoreTimedOut' },
  ]);
});

test('followsLeadScripts dies for an unscripted lead', async () => {
  const orderRepository = makeOrderRepository(orderRepositoryBuilder.store('followsLeadScripts'));
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const service = yield* OrderRepository;
      yield* service.store(lead('Unknown'));
    }).pipe(Effect.provide(orderRepository.layer))
  );

  expect(Result.getOrThrow(Exit.findDefect(exit))).toMatchObject({ message: 'No store script for lead: Unknown' });
});
