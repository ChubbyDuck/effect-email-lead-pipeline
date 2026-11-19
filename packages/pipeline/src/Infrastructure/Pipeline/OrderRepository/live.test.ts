import type { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Lead } from '@leads/shared/domain/types';
import { ConfigProvider, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, test, vi } from 'vitest';

import {
  AuthenticationFailed,
  OrderRepository,
  OrderStoreFailed,
  OrderStoreTimedOut,
} from '#Core/Pipeline/Ports/OrderRepository';

import { makeOrderRepositoryLive } from './live';

const lead: Lead = {
  extraction_source: 'new_acquisition',
  idempotencyKey: 'key',
  extracted: { name: 'Acme', city: undefined },
  raw: { Name: 'Acme', Ort: new Date('2026-09-27T00:00:00.000Z') },
};

const failure = (name: string) => Object.assign(new Error(name), { name });

const storedAt = '2026-10-16T09:30:00.000Z';

const layerOf = (dynamo: { send: unknown }) =>
  Layer.merge(
    makeOrderRepositoryLive(dynamo as unknown as DynamoDBDocumentClient).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ORDERS_TABLE_NAME: 'leads-test-orders' })))
    ),
    TestClock.layer()
  );

function store(send: (command: PutCommand) => Promise<unknown>) {
  const dynamo = { send: vi.fn(send) };
  const run = Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(storedAt));
      const repository = yield* OrderRepository;
      return yield* Effect.result(repository.store(lead));
    }).pipe(Effect.provide(layerOf(dynamo)))
  );
  return { dynamo, run };
}

/** A table that applies the condition of the put, as DynamoDB does. */
function table() {
  const items = new Map<unknown, Record<string, unknown>>();
  const send = vi.fn(async ({ input }: PutCommand) => {
    const item = input.Item!;
    if (items.has(item.idempotencyKey)) throw failure('ConditionalCheckFailedException');
    items.set(item.idempotencyKey, item);
    return {};
  });
  return { items, send };
}

test('puts the lead as JSON with the time of storage under its idempotency key, only when the key is new', async () => {
  const { dynamo, run } = store(async () => ({}));

  expect(await run).toMatchObject({ _tag: 'Success', success: undefined });
  expect(dynamo.send).toHaveBeenCalledOnce();
  expect(dynamo.send.mock.calls[0]![0].input).toEqual({
    TableName: 'leads-test-orders',
    Item: {
      extraction_source: 'new_acquisition',
      idempotencyKey: 'key',
      extracted: { name: 'Acme' },
      raw: { Name: 'Acme', Ort: '2026-09-27T00:00:00.000Z' },
      storedAt,
    },
    ConditionExpression: 'attribute_not_exists(idempotencyKey)',
  });
});

test('keeps the first time of storage when the same lead comes again later', async () => {
  const dynamo = table();

  const results = await Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* OrderRepository;
      yield* TestClock.setTime(Date.parse(storedAt));
      const first = yield* Effect.result(repository.store(lead));
      yield* TestClock.adjust('1 hour');
      const again = yield* Effect.result(repository.store(lead));
      return [first, again];
    }).pipe(Effect.provide(layerOf(dynamo)))
  );

  expect(results).toMatchObject([{ _tag: 'Success' }, { _tag: 'Success' }]);
  expect(dynamo.send).toHaveBeenCalledTimes(2);
  expect(dynamo.send.mock.calls[1]![0].input.Item).toMatchObject({ storedAt: '2026-10-16T10:30:00.000Z' });
  expect(dynamo.items.get('key')).toMatchObject({ storedAt });
});

test('succeeds when the lead is already stored', async () => {
  const { run } = store(() => Promise.reject(failure('ConditionalCheckFailedException')));

  expect(await run).toMatchObject({ _tag: 'Success', success: undefined });
});

test.each([
  { name: 'CredentialsProviderError', error: AuthenticationFailed },
  { name: 'ExpiredTokenException', error: AuthenticationFailed },
  { name: 'UnrecognizedClientException', error: AuthenticationFailed },
  { name: 'TimeoutError', error: OrderStoreTimedOut },
  { name: 'ThrottlingException', error: OrderStoreTimedOut },
  { name: 'ProvisionedThroughputExceededException', error: OrderStoreTimedOut },
  { name: 'ResourceNotFoundException', error: OrderStoreFailed },
  { name: 'AccessDeniedException', error: OrderStoreFailed },
])('keeps $name as the reason of $error.name', async ({ name, error }) => {
  const reason = failure(name);
  const { run } = store(() => Promise.reject(reason));

  const result = await run;
  expect(result._tag).toBe('Failure');
  if (result._tag !== 'Failure') return;
  expect(result.failure).toBeInstanceOf(error);
  expect(result.failure.reason).toBe(reason);
});

test('aborts the put when the store is interrupted', async () => {
  let signal: AbortSignal | undefined;
  const dynamo = {
    send: vi.fn((_: PutCommand, options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return new Promise(() => {});
    }),
  };
  const layer = makeOrderRepositoryLive(dynamo as unknown as DynamoDBDocumentClient).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ORDERS_TABLE_NAME: 'leads-test-orders' })))
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* OrderRepository;
      yield* Effect.timeoutOption(repository.store(lead), '10 millis');
    }).pipe(Effect.provide(layer))
  );

  expect(signal?.aborted).toBe(true);
});
