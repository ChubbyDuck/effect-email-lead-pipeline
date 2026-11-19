import { makeQueueLive } from '@leads/pipeline/infrastructure/Queue/live';
import { MessageBatchNotPushed, MessageNotPushed, Queue } from '@leads/pipeline/ports/Queue';
import { Effect, Layer } from 'effect';

import { leadSourcesSqsSockets, makeLeadSourcesSqsClient } from '#Entrypoints/Lambda/leadSourcesSqs';

import { e2eFlociEndpoint } from './config';
import { instrument } from './control';
import { LambdaServicesLive } from './services';

const sqs = makeLeadSourcesSqsClient(leadSourcesSqsSockets, e2eFlociEndpoint);
const queue = Layer.effect(
  Queue,
  Effect.gen(function* () {
    const live = yield* Queue;
    // Faults are injected per lead, so attempts stay observable per lead; the remaining leads go out as one batch.
    return {
      pushBatch: (messages) =>
        Effect.partition(
          messages,
          (message) =>
            instrument(
              'Queue.push',
              message.lead.extracted.name ?? '',
              Effect.succeed(message),
              () =>
                new MessageNotPushed({
                  requestID: message.requestID,
                  lead: message.lead,
                  reason: 'injected queue failure',
                })
            ),
          { concurrency: 'unbounded' }
        ).pipe(
          Effect.andThen(([passed, injected]) =>
            live.pushBatch(passed).pipe(
              Effect.as<readonly MessageNotPushed[]>([]),
              Effect.catchTag('MessageBatchNotPushed', (error) => Effect.succeed(error.failures)),
              Effect.andThen((failures) => {
                const all = [...injected, ...failures];
                return all.length > 0 ? Effect.fail(new MessageBatchNotPushed({ failures: all })) : Effect.void;
              })
            )
          )
        ),
    } satisfies typeof Queue.Service;
  }).pipe(Effect.provide(makeQueueLive(sqs)))
);
export const LeadSourcesServicesLive = Layer.mergeAll(LambdaServicesLive, queue);
