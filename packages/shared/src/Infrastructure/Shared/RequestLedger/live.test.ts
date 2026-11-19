import type { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConfigProvider, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, test, vi } from 'vitest';

import {
  inboxEnded,
  leadBatchEnded,
  pendingRequest,
  RequestID,
  type RequestProgress,
  sourceEnded,
} from '#Core/Shared/Domain/request';
import {
  RequestLedger,
  RequestNotAcknowledged,
  RequestNotRead,
  RequestNotRecorded,
  RequestsNotListed,
} from '#Core/Shared/Ports/RequestLedger';

import { makeRequestLedgerLive, retentionSeconds } from './live';

const requestID = RequestID.make('message-id');
const request = pendingRequest(requestID, new Date('2026-10-11T08:30:00.000Z'));
const now = '2026-10-11T08:31:15.000Z';
/** One week after `now`, in epoch seconds. */
const expiresAt = Date.parse(now) / 1000 + retentionSeconds;

const failure = (name: string) => Object.assign(new Error(name), { name });

const layerOf = (dynamo: Pick<DynamoDBDocumentClient, 'send'>) =>
  makeRequestLedgerLive(dynamo as unknown as DynamoDBDocumentClient).pipe(
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ REQUEST_LEDGER_TABLE_NAME: 'leads-test-request-ledger' }))
    )
  );

/** Runs one ledger call at the time `now`, so the test knows the `updatedAt` of the write. */
function run<C, A, E>(
  send: (command: C) => Promise<unknown>,
  call: (ledger: typeof RequestLedger.Service) => Effect.Effect<A, E>
) {
  const dynamo = { send: vi.fn(send) };
  const result = Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      const ledger = yield* RequestLedger;
      return yield* Effect.result(call(ledger));
    }).pipe(Effect.provide(Layer.merge(layerOf(dynamo as unknown as DynamoDBDocumentClient), TestClock.layer())))
  );
  return { dynamo, run: result };
}

const acknowledge = (send: (command: PutCommand) => Promise<unknown>) =>
  run(send, (ledger) => ledger.acknowledge(request));

const record = (progress: RequestProgress, send: (command: UpdateCommand) => Promise<unknown> = async () => ({})) =>
  run(send, (ledger) => ledger.record(requestID, progress));

test('puts the request under its ID with ISO dates, only when the ID is new', async () => {
  const { dynamo, run } = acknowledge(async () => ({}));

  expect(await run).toMatchObject({ _tag: 'Success', success: undefined });
  expect(dynamo.send).toHaveBeenCalledOnce();
  expect(dynamo.send.mock.calls[0]![0].input).toEqual({
    TableName: 'leads-test-request-ledger',
    Item: {
      requestID: 'message-id',
      receivedAt: '2026-10-11T08:30:00.000Z',
      updatedAt: now,
      expiresAt,
      inboxStatus: 'pending',
    },
    ConditionExpression: 'attribute_not_exists(requestID)',
  });
});

test('succeeds when the request is already in the ledger', async () => {
  const { run } = acknowledge(() => Promise.reject(failure('ConditionalCheckFailedException')));

  expect(await run).toMatchObject({ _tag: 'Success', success: undefined });
});

test.each(['CredentialsProviderError', 'ThrottlingException', 'ResourceNotFoundException'])(
  'keeps %s as the reason of RequestNotAcknowledged',
  async (name) => {
    const reason = failure(name);
    const { run } = acknowledge(() => Promise.reject(reason));

    const result = await run;
    expect(result._tag).toBe('Failure');
    if (result._tag !== 'Failure') return;
    expect(result.failure).toBeInstanceOf(RequestNotAcknowledged);
    expect(result.failure.request).toBe(request);
    expect(result.failure.reason).toBe(reason);
  }
);

test('aborts the put when the acknowledgement is interrupted', async () => {
  let signal: AbortSignal | undefined;
  const dynamo = {
    send: vi.fn((_: PutCommand, options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return new Promise(() => {});
    }),
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* RequestLedger;
      yield* Effect.timeoutOption(ledger.acknowledge(request), '10 millis');
    }).pipe(Effect.provide(layerOf(dynamo as unknown as DynamoDBDocumentClient)))
  );

  expect(signal?.aborted).toBe(true);
});

test('sets the entry to expire one week after the write, in epoch seconds', () => {
  expect(expiresAt).toBe(Date.parse('2026-10-18T08:31:15.000Z') / 1000);
});

describe('record', () => {
  test('sets the inbox status and the time of the change on the entry of the request', async () => {
    const { dynamo, run } = record(inboxEnded('rejected'));

    expect(await run).toMatchObject({ _tag: 'Success', success: undefined });
    expect(dynamo.send).toHaveBeenCalledOnce();
    expect(dynamo.send.mock.calls[0]![0].input).toEqual({
      TableName: 'leads-test-request-ledger',
      Key: { requestID: 'message-id' },
      UpdateExpression: 'SET #updatedAt = :updatedAt, #expiresAt = :expiresAt, #inboxStatus = :inboxStatus',
      ExpressionAttributeNames: { '#updatedAt': 'updatedAt', '#expiresAt': 'expiresAt', '#inboxStatus': 'inboxStatus' },
      ExpressionAttributeValues: { ':updatedAt': now, ':expiresAt': expiresAt, ':inboxStatus': 'rejected' },
    });
  });

  test('sets the number of attachments, also when it is 0', async () => {
    const { dynamo, run } = record({ attachments: 0 });

    await run;
    expect(dynamo.send.mock.calls[0]![0].input).toMatchObject({
      UpdateExpression: 'SET #updatedAt = :updatedAt, #expiresAt = :expiresAt, #attachments = :attachments',
      ExpressionAttributeNames: { '#attachments': 'attachments' },
      ExpressionAttributeValues: { ':attachments': 0 },
    });
  });

  test('adds every counter delta in one update, so pending and the outcome move together', async () => {
    const { dynamo, run } = record(sourceEnded('failed', 3));

    await run;
    expect(dynamo.send.mock.calls[0]![0].input).toEqual({
      TableName: 'leads-test-request-ledger',
      Key: { requestID: 'message-id' },
      UpdateExpression:
        'SET #updatedAt = :updatedAt, #expiresAt = :expiresAt ADD #sourcesPending :sourcesPending, #sourcesFailed :sourcesFailed, #leadsFailed :leadsFailed',
      ExpressionAttributeNames: {
        '#updatedAt': 'updatedAt',
        '#expiresAt': 'expiresAt',
        '#sourcesPending': 'sourcesPending',
        '#sourcesFailed': 'sourcesFailed',
        '#leadsFailed': 'leadsFailed',
      },
      ExpressionAttributeValues: {
        ':updatedAt': now,
        ':expiresAt': expiresAt,
        ':sourcesPending': -1,
        ':sourcesFailed': 1,
        ':leadsFailed': 3,
      },
    });
  });

  test('adds no counter that has a delta of 0', async () => {
    const { dynamo, run } = record({
      ...leadBatchEnded({ processed: 2, failed: 0 }),
      leadsFailed: 0,
      leadsRejected: 0,
    });

    await run;
    expect(dynamo.send.mock.calls[0]![0].input).toMatchObject({
      UpdateExpression:
        'SET #updatedAt = :updatedAt, #expiresAt = :expiresAt ADD #leadsPending :leadsPending, #leadsProcessed :leadsProcessed',
      ExpressionAttributeValues: { ':updatedAt': now, ':leadsPending': -2, ':leadsProcessed': 2 },
    });
  });

  test.each(['CredentialsProviderError', 'ThrottlingException', 'ConditionalCheckFailedException'])(
    'keeps %s as the reason of RequestNotRecorded',
    async (name) => {
      const reason = failure(name);
      const progress = inboxEnded('processed');
      const { run } = record(progress, () => Promise.reject(reason));

      const result = await run;
      expect(result._tag).toBe('Failure');
      if (result._tag !== 'Failure') return;
      expect(result.failure).toBeInstanceOf(RequestNotRecorded);
      expect(result.failure.requestID).toBe('message-id');
      expect(result.failure.progress).toBe(progress);
      expect(result.failure.reason).toBe(reason);
    }
  );
});

describe('changedSince', () => {
  const since = new Date('2026-10-11T08:00:00.000Z');
  const item = (requestID: string, change: Record<string, unknown> = {}) => ({
    requestID,
    updatedAt: now,
    ...change,
  });

  const changedSince = (send: (command: ScanCommand) => Promise<unknown>) =>
    run(send, (ledger) => ledger.changedSince(since));

  test('scans for the entries changed at or after the time, as ISO strings', async () => {
    const { dynamo, run } = changedSince(async () => ({ Items: [] }));

    expect(await run).toMatchObject({ _tag: 'Success', success: [] });
    expect(dynamo.send).toHaveBeenCalledOnce();
    expect(dynamo.send.mock.calls[0]![0].input).toEqual({
      TableName: 'leads-test-request-ledger',
      FilterExpression: '#updatedAt >= :since',
      ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':since': '2026-10-11T08:00:00.000Z' },
    });
  });

  test('reads every page and decodes each item into an entry', async () => {
    const pages = [
      {
        Items: [item('first', { receivedAt: '2026-10-11T07:59:00.000Z', inboxStatus: 'processed', attachments: 2 })],
        LastEvaluatedKey: { requestID: 'first' },
      },
      { Items: [item('second', { sourcesPending: 1, sourcesLeads: 4 })] },
    ];
    const { dynamo, run } = changedSince(async () => pages.shift());

    const result = await run;
    expect(dynamo.send).toHaveBeenCalledTimes(2);
    expect(dynamo.send.mock.calls[1]![0].input.ExclusiveStartKey).toEqual({ requestID: 'first' });
    expect(result).toMatchObject({
      _tag: 'Success',
      success: [
        {
          requestID: 'first',
          receivedAt: new Date('2026-10-11T07:59:00.000Z'),
          updatedAt: new Date(now),
          inboxStatus: 'processed',
          attachments: 2,
          sourcesPending: 0,
          leadsProcessed: 0,
        },
        { requestID: 'second', updatedAt: new Date(now), sourcesPending: 1, sourcesLeads: 4, leadsPending: 0 },
      ],
    });
  });

  test.each(['CredentialsProviderError', 'ThrottlingException', 'ResourceNotFoundException'])(
    'keeps %s as the reason of RequestsNotListed',
    async (name) => {
      const reason = failure(name);
      const { run } = changedSince(() => Promise.reject(reason));

      const result = await run;
      expect(result._tag).toBe('Failure');
      if (result._tag !== 'Failure') return;
      expect(result.failure).toBeInstanceOf(RequestsNotListed);
      expect(result.failure.since).toBe(since);
      expect(result.failure.reason).toBe(reason);
    }
  );

  test('fails with RequestsNotListed when an item is not an entry', async () => {
    const { run } = changedSince(async () => ({ Items: [item('first', { inboxStatus: 'lost' })] }));

    const result = await run;
    expect(result._tag).toBe('Failure');
    if (result._tag !== 'Failure') return;
    expect(result.failure).toBeInstanceOf(RequestsNotListed);
    expect(result.failure.reason).toBeDefined();
  });
});

describe('entryOf', () => {
  const entryOf = (send: (command: GetCommand) => Promise<unknown>) => run(send, (ledger) => ledger.entryOf(requestID));

  test('gets the item under the request ID and decodes it into an entry', async () => {
    const { dynamo, run } = entryOf(async () => ({
      Item: {
        requestID,
        receivedAt: '2026-10-11T08:30:00.000Z',
        updatedAt: now,
        inboxStatus: 'processed',
        attachments: 3,
      },
    }));

    expect(await run).toMatchObject({
      _tag: 'Success',
      success: {
        requestID,
        receivedAt: new Date('2026-10-11T08:30:00.000Z'),
        updatedAt: new Date(now),
        attachments: 3,
        sourcesPending: 0,
      },
    });
    expect(dynamo.send.mock.calls[0]![0].input).toEqual({
      TableName: 'leads-test-request-ledger',
      Key: { requestID },
    });
  });

  test('gives no entry when the ledger has no item', async () => {
    const { run } = entryOf(async () => ({}));

    expect(await run).toMatchObject({ _tag: 'Success', success: undefined });
  });

  test('keeps the failure of the get as the reason of RequestNotRead', async () => {
    const reason = failure('ThrottlingException');
    const { run } = entryOf(() => Promise.reject(reason));

    const result = await run;
    expect(result._tag).toBe('Failure');
    if (result._tag !== 'Failure') return;
    expect(result.failure).toBeInstanceOf(RequestNotRead);
    expect(result.failure.requestID).toBe(requestID);
    expect(result.failure.reason).toBe(reason);
  });

  test('fails with RequestNotRead when the item is not an entry', async () => {
    const { run } = entryOf(async () => ({ Item: { requestID, updatedAt: now, inboxStatus: 'lost' } }));

    const result = await run;
    expect(result._tag).toBe('Failure');
    if (result._tag !== 'Failure') return;
    expect(result.failure).toBeInstanceOf(RequestNotRead);
    expect(result.failure.reason).toBeDefined();
  });
});
