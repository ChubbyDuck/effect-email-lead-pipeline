import { QueueBatchSize } from '@leads/shared/domain/queueLimits';
import { RequestID } from '@leads/shared/domain/request';
import { Effect, Exit } from 'effect';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { makeFloci } from '#Core/Pipeline/Application/UseCases/testing/floci';
import { sources } from '#Core/Pipeline/Application/UseCases/testing/workbooks';
import { toLeadsAndRejectionsFromSheet } from '#Core/Pipeline/Domain/Transformations/leadSources';
import { MessageBatchNotPushed, MessageNotPushed, Queue } from '#Core/Pipeline/Ports/Queue';

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

test('publishes a full batch of leads and request IDs as JSON SQS messages and returns void', async () => {
  const first = await lead();
  const messages = Array.from({ length: QueueBatchSize }, (_, index) => ({
    lead: { ...first, extracted: { ...first.extracted, name: `Lead ${index}` } },
    requestID: RequestID.make('queue-integration'),
  }));
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const queue = yield* Queue;
      yield* queue.pushBatch(messages);
    }).pipe(Effect.provide(floci.services({ errors: [], warnings: [] })))
  );

  expect(exit).toEqual(Exit.succeed(undefined));
  const received = await floci.receiveLeads();
  const bodies = received.map((message) => JSON.parse(message.Body!) as (typeof messages)[number]);
  expect(
    bodies.toSorted((a, b) =>
      (a.lead.extracted.name ?? '').localeCompare(b.lead.extracted.name ?? '', 'en', { numeric: true })
    )
  ).toEqual(JSON.parse(JSON.stringify(messages)));
  for (const message of received) await floci.acknowledge(message);
});

test('preserves a missing-queue SDK error as the reason of each MessageNotPushed', async () => {
  const message = { lead: await lead(), requestID: RequestID.make('failed-queue-integration') };
  const missingQueueUrl = floci.queueUrl.replace(/[^/]+$/, 'missing-leads-queue');
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const queue = yield* Queue;
      return yield* Effect.flip(queue.pushBatch([message]));
    }).pipe(Effect.provide(floci.services({ errors: [], warnings: [] }, undefined, undefined, missingQueueUrl)))
  );

  expect(error).toBeInstanceOf(MessageBatchNotPushed);
  expect(error.failures).toHaveLength(1);
  expect(error.failures[0]).toBeInstanceOf(MessageNotPushed);
  expect(error.failures[0]).toMatchObject({ requestID: message.requestID, reason: { name: 'QueueDoesNotExist' } });
  expect(await floci.receiveLeads()).toEqual([]);
});
