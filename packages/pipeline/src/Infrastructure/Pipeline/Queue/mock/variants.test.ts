import { RequestID } from '@leads/shared/domain/request';
import { unimplemented } from '@leads/shared/testing/variants';
import { Effect, Exit } from 'effect';
import { expect, test } from 'vitest';

import { MessageBatchNotPushed, MessageNotPushed, Queue } from '#Core/Pipeline/Ports/Queue';

import { makeQueue, queueBuilder } from './variants';

const messageFor = (name: string, requestID = RequestID.make('request-id')) => ({
  lead: {
    extraction_source: 'new_acquisition' as const,
    idempotencyKey: `key-${name}`,
    extracted: { name },
    raw: { Name: name },
  },
  requestID,
});
const message = messageFor('Broken');
const brokenFailure = (failed = message) =>
  Exit.fail(
    new MessageBatchNotPushed({
      failures: [new MessageNotPushed({ requestID: failed.requestID, lead: failed.lead, reason: 'Broken' })],
    })
  );

test('omitting Queue.pushBatch leaves it strict', async () => {
  const queue = makeQueue();
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const service = yield* Queue;
      yield* service.pushBatch([message]);
    }).pipe(Effect.provide(queue.layer))
  );

  if (!Exit.isFailure(exit)) throw new Error('Expected a failed Exit');
  expect(exit.cause.reasons).toHaveLength(1);
  expect(exit.cause.reasons).toMatchObject([
    {
      _tag: 'Die',
      defect: unimplemented(Queue, 'pushBatch'),
    },
  ]);
  expect(queue.observation.calls).toEqual([]);
});

test('failsWithMessageBatchNotPushedForBrokenLead fails only the Broken messages of a batch', async () => {
  const queue = makeQueue(queueBuilder.pushBatch('failsWithMessageBatchNotPushedForBrokenLead'));
  const acme = messageFor('Acme');
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const service = yield* Queue;
      yield* service.pushBatch([acme, message]);
    }).pipe(Effect.provide(queue.layer))
  );

  expect(exit).toEqual(brokenFailure());
  expect(queue.observation.calls).toEqual([{ method: 'pushBatch', params: [[acme, message]] }]);
});

test('script state and observations belong to each instance and advance only when executed', async () => {
  const selected = queueBuilder.pushBatch('succeedsAfterTwoMessageBatchNotPushedFailures');
  const first = makeQueue(selected);
  const second = makeQueue(selected);
  const getService = Effect.gen(function* () {
    // Wrap the strict proxy so Promise resolution does not access its omitted `then` member.
    return { service: yield* Queue };
  });
  const { service: firstService } = await Effect.runPromise(getService.pipe(Effect.provide(first.layer)));
  const { service: secondService } = await Effect.runPromise(getService.pipe(Effect.provide(second.layer)));
  const operation = firstService.pushBatch([message]);

  expect(first.observation.calls).toEqual([]);
  expect(second.observation.calls).toEqual([]);
  expect(await Effect.runPromiseExit(operation)).toEqual(brokenFailure());
  expect(await Effect.runPromiseExit(operation)).toEqual(brokenFailure());
  expect(await Effect.runPromiseExit(operation)).toEqual(Exit.succeed(undefined));
  expect(second.observation.calls).toEqual([]);
  expect(await Effect.runPromiseExit(secondService.pushBatch([message]))).toEqual(brokenFailure());

  const anotherRequest = messageFor('Broken', RequestID.make('another-request'));
  expect(await Effect.runPromiseExit(firstService.pushBatch([anotherRequest]))).toEqual(brokenFailure(anotherRequest));
  expect(first.observation.calls).toEqual([
    { method: 'pushBatch', params: [[message]] },
    { method: 'pushBatch', params: [[message]] },
    { method: 'pushBatch', params: [[message]] },
    { method: 'pushBatch', params: [[anotherRequest]] },
  ]);
  expect(second.observation.calls).toEqual([{ method: 'pushBatch', params: [[message]] }]);
});
