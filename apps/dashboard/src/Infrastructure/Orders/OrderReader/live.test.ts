import type { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, test, vi } from 'vitest';

import { OrderReader, OrdersNotRead } from '#Core/Orders/Ports/OrderReader';

import { makeOrderReaderLive } from './live';

const readAt = '2026-10-16T12:00:00.000Z';
const storedAt = '2026-10-16T09:30:00.000Z';

const failure = (name: string) => Object.assign(new Error(name), { name });

/** An item as the order repository writes it: the lead as JSON, and the time of storage. */
const item = (key: string, extra: Record<string, unknown> = { storedAt }) => ({
  extraction_source: 'new_acquisition',
  idempotencyKey: key,
  extracted: { name: `Name of ${key}`, city: 'Bern' },
  raw: { Name: `Name of ${key}`, Ort: 'Bern' },
  ...extra,
});

const layerOf = (dynamo: { send: unknown }) =>
  Layer.merge(
    makeOrderReaderLive(dynamo as unknown as DynamoDBDocumentClient).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ORDERS_TABLE_NAME: 'leads-test-orders' })))
    ),
    TestClock.layer()
  );

/** Reads all the orders from a table that gives the scan pages one after the other. */
function readAll(send: (command: ScanCommand) => Promise<unknown>) {
  const dynamo = { send: vi.fn(send) };
  const run = Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(readAt));
      const reader = yield* OrderReader;
      return yield* Effect.result(reader.all);
    }).pipe(Effect.provide(layerOf(dynamo)))
  );
  return { dynamo, run };
}

test('scans every page of the table and gives each item as an order with its time of storage', async () => {
  const pages = [
    { Items: [item('a'), item('b')], LastEvaluatedKey: { idempotencyKey: 'b' } },
    { Items: [], LastEvaluatedKey: { idempotencyKey: 'c' } },
    { Items: [item('d')] },
  ];
  const { dynamo, run } = readAll(async () => pages.shift());

  const result = await run;

  expect(dynamo.send.mock.calls.map(([command]) => command.input)).toEqual([
    { TableName: 'leads-test-orders' },
    { TableName: 'leads-test-orders', ExclusiveStartKey: { idempotencyKey: 'b' } },
    { TableName: 'leads-test-orders', ExclusiveStartKey: { idempotencyKey: 'c' } },
  ]);
  expect(result).toMatchObject({ _tag: 'Success', success: { readAt } });
  if (result._tag !== 'Success') return;
  expect(result.success.orders.map(({ lead, storedAt }) => [lead.idempotencyKey, storedAt])).toEqual([
    ['a', storedAt],
    ['b', storedAt],
    ['d', storedAt],
  ]);
  expect(result.success.orders[0]).toEqual({
    lead: {
      extraction_source: 'new_acquisition',
      idempotencyKey: 'a',
      extracted: { name: 'Name of a', city: 'Bern' },
      raw: { Name: 'Name of a', Ort: 'Bern' },
    },
    storedAt,
  });
});

test('gives undefined as the time of storage of an item without one', async () => {
  const { run } = readAll(async () => ({ Items: [item('old', {})] }));

  expect(await run).toMatchObject({ _tag: 'Success', success: { orders: [{ storedAt: undefined }] } });
});

test('fails the read with the key of an item that does not decode', async () => {
  const { run } = readAll(async () => ({
    Items: [item('good'), item('bad', { extraction_source: 'unknown', storedAt })],
  }));

  const result = await run;

  expect(result._tag).toBe('Failure');
  if (result._tag !== 'Failure') return;
  expect(result.failure).toBeInstanceOf(OrdersNotRead);
  expect(result.failure).toMatchObject({ key: 'bad', authentication: false, message: expect.stringContaining('bad') });
  // The reason is the decode failure of the lead schema, unchanged.
  expect(result.failure.reason).toBeInstanceOf(Schema.SchemaError);
});

test.each([
  { name: 'CredentialsProviderError', authentication: true },
  { name: 'ExpiredTokenException', authentication: true },
  { name: 'UnrecognizedClientException', authentication: true },
  { name: 'ResourceNotFoundException', authentication: false },
  { name: 'AccessDeniedException', authentication: false },
])('keeps $name as the reason of OrdersNotRead', async ({ name, authentication }) => {
  const reason = failure(name);
  const { run } = readAll(() => Promise.reject(reason));

  const result = await run;

  expect(result._tag).toBe('Failure');
  if (result._tag !== 'Failure') return;
  expect(result.failure).toBeInstanceOf(OrdersNotRead);
  expect(result.failure.reason).toBe(reason);
  expect(result.failure.authentication).toBe(authentication);
});
