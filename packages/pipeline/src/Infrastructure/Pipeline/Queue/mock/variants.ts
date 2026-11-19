import { definePortMock } from '@leads/shared/testing/variants';
import { Effect } from 'effect';

import type { QueuedLead } from '#Core/Pipeline/Domain/queuedLead';
import { MessageBatchNotPushed, MessageNotPushed, Queue } from '#Core/Pipeline/Ports/Queue';

// Each entry describes this lead's own attempts: false fails, true succeeds.
const recoveryScripts: Readonly<Record<string, readonly boolean[]>> = {
  Acme: [true],
  Broken: [false, false, true],
};

const notPushed = (message: QueuedLead, reason: unknown) =>
  new MessageNotPushed({ requestID: message.requestID, lead: message.lead, reason });

const failWith = (failures: readonly MessageNotPushed[]) =>
  failures.length > 0 ? Effect.fail(new MessageBatchNotPushed({ failures })) : Effect.void;

const queueMock = definePortMock(Queue, ({ method, record, observation }) => {
  const pushBatch = record('pushBatch');
  const attemptsByMessage = new Map<string, number>();

  return {
    variants: {
      pushBatch: method('pushBatch', {
        failsWithMessageBatchNotPushed: (messages) =>
          pushBatch(messages).pipe(
            Effect.andThen(() => failWith(messages.map((message) => notPushed(message, 'unavailable'))))
          ),
        failsWithMessageBatchNotPushedForBrokenLead: (messages) =>
          pushBatch(messages).pipe(
            Effect.andThen(() =>
              failWith(
                messages
                  .filter((message) => message.lead.extracted.name === 'Broken')
                  .map((message) => notPushed(message, 'Broken'))
              )
            )
          ),
        succeedsAfterTwoMessageBatchNotPushedFailures: (messages) =>
          pushBatch(messages).pipe(
            Effect.andThen(() =>
              Effect.suspend(() => {
                const failures: MessageNotPushed[] = [];
                for (const message of messages) {
                  const name = message.lead.extracted.name ?? '';
                  const identity = JSON.stringify([message.requestID, name]);
                  const attempt = attemptsByMessage.get(identity) ?? 0;
                  const succeeds = recoveryScripts[name]?.[attempt];
                  if (succeeds === undefined) {
                    return Effect.die(
                      new Error(`No Queue.pushBatch script for message ${identity}, attempt ${attempt + 1}`)
                    );
                  }
                  attemptsByMessage.set(identity, attempt + 1);
                  if (!succeeds) failures.push(notPushed(message, name));
                }
                return failWith(failures);
              })
            )
          ),
        succeeds: pushBatch,
      }),
    },
    observation,
  };
});

export const queueBuilder = queueMock.builder;
export const makeQueue = queueMock.make;
