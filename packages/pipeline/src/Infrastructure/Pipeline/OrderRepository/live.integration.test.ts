import type { Lead } from '@leads/shared/domain/types';
import { Effect, Exit } from 'effect';
import { TestClock } from 'effect/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { makeFloci } from '#Core/Pipeline/Application/UseCases/testing/floci';
import { sources } from '#Core/Pipeline/Application/UseCases/testing/workbooks';
import { toLeadsAndRejectionsFromSheet } from '#Core/Pipeline/Domain/Transformations/leadSources';
import { OrderRepository, OrderStoreFailed } from '#Core/Pipeline/Ports/OrderRepository';

const floci = makeFloci();
beforeAll(() => floci.setup());
afterAll(() => floci.cleanup());

const lead = async () => {
  const source = sources[1];
  const { leads } = await Effect.runPromise(
    toLeadsAndRejectionsFromSheet({ header: source.header, rows: [source.rows[0]] })
  );
  return leads[0]!;
};

const storedAt = '2026-10-16T09:30:00.000Z';

const storing = (lead: Lead, { ordersTableName, at = storedAt }: { ordersTableName?: string; at?: string } = {}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at));
    const repository = yield* OrderRepository;
    yield* repository.store(lead);
  }).pipe(
    Effect.provide(floci.services({ errors: [], warnings: [] }, undefined, undefined, undefined, ordersTableName))
  );

const store = (lead: Lead, at = storedAt) => Effect.runPromiseExit(storing(lead, { at }));

test('stores the lead as an order with its time of storage under its idempotency key', async () => {
  const first = await lead();

  expect(await store(first)).toEqual(Exit.succeed(undefined));
  expect(await floci.order(first.idempotencyKey)).toEqual({ ...JSON.parse(JSON.stringify(first)), storedAt });
});

test('keeps the first order and its time of storage when a lead with the same idempotency key comes again', async () => {
  const first = await lead();
  const again = { ...first, extracted: { ...first.extracted, name: 'Resent' } };

  expect(await store(first)).toEqual(Exit.succeed(undefined));
  expect(await store(again, '2026-10-16T10:30:00.000Z')).toEqual(Exit.succeed(undefined));
  expect(await floci.order(first.idempotencyKey)).toMatchObject({
    extracted: { name: first.extracted.name },
    storedAt,
  });
});

test('keeps a missing-table SDK error as the reason of OrderStoreFailed', async () => {
  const error = await Effect.runPromise(
    Effect.flip(storing(await lead(), { ordersTableName: 'missing-orders-table' }))
  );

  expect(error).toBeInstanceOf(OrderStoreFailed);
  expect(error).toMatchObject({ reason: { name: 'ResourceNotFoundException' } });
});
