import type { Message } from '@aws-sdk/client-sqs';
import type { RequestID } from '@leads/shared/domain/request';
import { Lead } from '@leads/shared/domain/types';
import { Effect, Exit, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { handler as handleLeadSources } from '#Core/Pipeline/Application/UseCases/HandleLeadSources/handler';
import { instant, leadRecords, makeFloci } from '#Core/Pipeline/Application/UseCases/testing/floci';
import { newRequestID } from '#Core/Pipeline/Application/UseCases/testing/request';
import { sources, workbook } from '#Core/Pipeline/Application/UseCases/testing/workbooks';
import { toLeadsAndRejectionsFromSheet } from '#Core/Pipeline/Domain/Transformations/leadSources';
import { OrderRepository, OrderStoreFailed } from '#Core/Pipeline/Ports/OrderRepository';
import { Queue } from '#Core/Pipeline/Ports/Queue';

import { handler, LeadNotHandled } from './handler';

const floci = makeFloci();
const { buckets } = floci;

beforeAll(() => floci.setup());
afterAll(() => floci.cleanup());

async function run(messages: readonly Message[], orderRepository: Layer.Layer<OrderRepository>) {
  const logged = { errors: [] as unknown[], warnings: [] as unknown[] };
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* TestClock.setTime(instant.getTime());
      return yield* handler({
        records: leadRecords(messages),
        functionName: 'leadHandler',
        source: 'integration-test',
      });
    }).pipe(Effect.provide(floci.services(logged, orderRepository)))
  );
  return { exit, logged };
}

async function validLeads(): Promise<readonly Lead[]> {
  const source = sources[1];
  const { leads } = await Effect.runPromise(
    toLeadsAndRejectionsFromSheet({ header: source.header, rows: source.rows })
  );
  return leads;
}

async function publish(leads: readonly Lead[], requestID: RequestID) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const queue = yield* Queue;
      yield* queue.pushBatch(leads.map((lead) => ({ lead, requestID })));
    }).pipe(Effect.provide(floci.services({ errors: [], warnings: [] })))
  );
  return floci.receiveLeads();
}

const decodeLeadMessage = (message: Message) =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ lead: Lead })))(message.Body!).lead;

const byName = (a: Lead, b: Lead) => (a.extracted.name ?? '').localeCompare(b.extracted.name ?? '');

test('consumes both queue messages produced by HandleLeadSources and returns no unprocessed leads', async () => {
  const source = sources[1];
  const requestID = newRequestID();
  const sourceKey = `received/${requestID}/pipeline-new-acquisition.xlsx`;
  const sourceBody = workbook(source.header, source.rows);
  await floci.put(buckets.sources, sourceKey, sourceBody);
  const sourceLogs = { errors: [] as unknown[], warnings: [] as unknown[] };
  await Effect.runPromise(
    handleLeadSources({
      bucket: buckets.sources,
      key: sourceKey,
      functionName: 'leadSourcesHandler',
    }).pipe(Effect.provide(floci.services(sourceLogs)))
  );

  expect(sourceLogs).toEqual({ errors: [], warnings: [] });
  expect(await floci.exists(buckets.sources, sourceKey)).toBe(false);
  const messages = await floci.receiveLeads();
  expect(messages).toHaveLength(2);
  const stored: Lead[] = [];
  const orderRepository = Layer.succeed(OrderRepository, {
    store: (lead) =>
      Effect.sync(() => {
        stored.push(lead);
      }),
  });

  const result = await run(messages, orderRepository);

  expect(result.exit).toEqual(Exit.succeed([]));
  expect(result.logged).toEqual({ errors: [], warnings: [] });
  expect(stored.toSorted(byName)).toEqual(messages.map(decodeLeadMessage).toSorted(byName));
  expect(stored.map((lead) => lead.extracted.name).sort()).toEqual(source.rows.map((row) => row.Name).sort());
  for (const message of messages) await floci.acknowledge(message);
  expect(await floci.receiveLeads()).toEqual([]);
});

test('stores the valid queue message and returns a rejected sibling record for a redrive', async () => {
  const requestID = newRequestID();
  const [lead] = await validLeads();
  const messages = await publish([lead!], requestID);
  await floci.sendLeadMessage(JSON.stringify({ lead: { extraction_source: 'unknown' }, requestID }));
  const rejected = await floci.receiveLeads();
  expect(messages).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const stored: Lead[] = [];
  const orderRepository = Layer.succeed(OrderRepository, {
    store: (item) =>
      Effect.sync(() => {
        stored.push(item);
      }),
  });

  const result = await run([...messages, ...rejected], orderRepository);

  const notHandled = new LeadNotHandled({
    messageId: rejected[0]!.MessageId!,
    reason: expect.objectContaining({ message: expect.stringContaining('Expected') }),
  });
  expect(result.exit).toEqual(Exit.succeed([notHandled]));
  expect(stored).toEqual([lead]);
  expect(result.logged).toEqual({ errors: [notHandled], warnings: [] });
  for (const message of [...messages, ...rejected]) await floci.acknowledge(message);
});

test.each([
  { name: 'malformed-json', body: '{"lead":' },
  { name: 'empty-json-object', body: '{}' },
])('returns and logs a $name queue record for a redrive', async ({ body }) => {
  await floci.sendLeadMessage(body);
  const messages = await floci.receiveLeads();
  expect(messages).toHaveLength(1);
  const orderRepository = Layer.mock(OrderRepository, {});

  const result = await run(messages, orderRepository);

  const notHandled = new LeadNotHandled({ messageId: messages[0]!.MessageId!, reason: expect.anything() });
  expect(result.exit).toEqual(Exit.succeed([notHandled]));
  expect(result.logged).toEqual({ errors: [notHandled], warnings: [] });
  await floci.acknowledge(messages[0]!);
});

test('retains only the failed message from a partial batch, then redelivers it without repeating successful work', async () => {
  const requestID = newRequestID();
  const leads = await validLeads();
  const messages = await publish(leads, requestID);
  expect(messages).toHaveLength(2);
  const attempted: Lead[] = [];
  const stored: Lead[] = [];
  const orderRepository = Layer.succeed(OrderRepository, {
    store: (lead) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          attempted.push(lead);
        });
        if (lead.extracted.name === 'Marktgasse Bistro AG') {
          return yield* new OrderStoreFailed({ reason: 'downstream unavailable' });
        }
        yield* Effect.sync(() => {
          stored.push(lead);
        });
      }),
  });
  const failedMessage = messages.find(
    (message) => decodeLeadMessage(message).extracted.name === 'Marktgasse Bistro AG'
  )!;
  const successfulMessage = messages.find((message) => message.MessageId !== failedMessage.MessageId)!;

  const result = await run([failedMessage, successfulMessage], orderRepository);

  const notHandled = new LeadNotHandled({
    messageId: failedMessage.MessageId!,
    reason: new OrderStoreFailed({ reason: 'downstream unavailable' }),
  });
  expect(result.exit).toEqual(Exit.succeed([notHandled]));
  expect(attempted.toSorted(byName)).toEqual(leads.toSorted(byName));
  expect(stored).toEqual([decodeLeadMessage(successfulMessage)]);
  expect(result.logged).toEqual({ errors: [notHandled], warnings: [] });

  // Emulate the consumer: acknowledge success and restore visibility only for the returned failed ID.
  await floci.acknowledge(successfulMessage);
  await floci.releaseLead(failedMessage);
  const retry = await floci.receiveLeads();
  expect(retry.map((message) => message.MessageId)).toEqual([failedMessage.MessageId]);
  expect(retry.map(decodeLeadMessage)).toEqual([decodeLeadMessage(failedMessage)]);
  const recoveringRepository = Layer.succeed(OrderRepository, {
    store: (lead) =>
      Effect.sync(() => {
        stored.push(lead);
      }),
  });
  const recovered = await run(retry, recoveringRepository);

  expect(recovered.exit).toEqual(Exit.succeed([]));
  expect(recovered.logged).toEqual({ errors: [], warnings: [] });
  expect(stored.toSorted(byName)).toEqual(leads.toSorted(byName));
  await floci.acknowledge(retry[0]!);
  expect(await floci.receiveLeads()).toEqual([]);
});
