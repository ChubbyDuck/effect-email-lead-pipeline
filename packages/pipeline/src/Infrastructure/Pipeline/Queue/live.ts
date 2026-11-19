import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Config, Effect, Layer } from 'effect';

import { encodeQueuedLead, type QueuedLead } from '#Core/Pipeline/Domain/queuedLead';
import { MessageBatchNotPushed, MessageNotPushed, Queue } from '#Core/Pipeline/Ports/Queue';

const toFailure = (message: QueuedLead, reason: unknown) =>
  new MessageNotPushed({ requestID: message.requestID, lead: message.lead, reason });

export const makeQueueLive = (sqs: SQSClient) =>
  Layer.effect(
    Queue,
    Effect.gen(function* () {
      const queueUrl = yield* Config.String('LEADS_QUEUE_URL');

      return {
        pushBatch: (messages) =>
          messages.length === 0
            ? Effect.void
            : Effect.tryPromise({
                try: (abortSignal) =>
                  sqs.send(
                    new SendMessageBatchCommand({
                      QueueUrl: queueUrl,
                      Entries: messages.map((message, index) => ({
                        Id: String(index),
                        MessageBody: encodeQueuedLead(message),
                      })),
                    }),
                    { abortSignal }
                  ),
                catch: (reason) =>
                  new MessageBatchNotPushed({ failures: messages.map((message) => toFailure(message, reason)) }),
              }).pipe(
                Effect.andThen(({ Failed = [] }) => {
                  const failures = Failed.flatMap((entry) => {
                    const message = messages[Number(entry.Id)];
                    return message === undefined ? [] : [toFailure(message, entry)];
                  });
                  return failures.length > 0 ? Effect.fail(new MessageBatchNotPushed({ failures })) : Effect.void;
                })
              ),
      };
    })
  );
