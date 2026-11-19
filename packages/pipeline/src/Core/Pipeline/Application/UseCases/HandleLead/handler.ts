import { leadBatchEnded, leadBatchStarted } from '@leads/shared/domain/request';
import { withReason } from '@leads/shared/utils';
import { Array, Cause, Data, Duration, Effect, Exit, Ref } from 'effect';

import { AppConfig } from '#Core/Pipeline/Application/config';
import { makeProgressRecorder } from '#Core/Pipeline/Application/progress';
import { retryPolicy } from '#Core/Pipeline/Application/retry';
import { toLeadsAndRejectionsFromRecords } from '#Core/Pipeline/Domain/Transformations/leads';
import { AuthenticationFailed, OrderRepository, OrderStoreTimedOut } from '#Core/Pipeline/Ports/OrderRepository';

import type { Command } from './command';

export class LeadNotHandled extends Data.TaggedError('LeadNotHandled')<{
  readonly messageId: string;
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason(`Lead message ${this.messageId} is not handled`, this.reason);
  }
}

/** Returns the messages that are not handled, so the caller can report them as failures and SQS moves them to the DLQ. */
export function handler(command: Command) {
  return Effect.gen(function* () {
    const config = yield* AppConfig;
    const orderRepository = yield* OrderRepository;
    const progress = yield* makeProgressRecorder;

    const { leads, leadRejections } = yield* toLeadsAndRejectionsFromRecords(command.records);

    // Each message stays here until its lead is stored, with the reason of its failure when one is known.
    const unhandledMessageIDs = yield* Ref.make(
      new Map<string, unknown>([...[...leads.keys()].map((messageId) => [messageId, undefined] as const)])
    );
    // A batch can hold the leads of many requests, so each request counts only its own leads, in one write for each.
    // The ID comes from a message of the group, because a record key loses the RequestID type.
    const requests = Object.values(Array.groupBy([...leads], ([, { requestID }]) => requestID)).map(
      (messages) => [messages[0][1].requestID, messages] as const
    );
    yield* Effect.forEach(
      requests,
      ([requestID, messages]) => progress.record(requestID, leadBatchStarted(messages.length)),
      { concurrency: config.leadInternalConcurrency, discard: true }
    );
    const exit = yield* Effect.forEach(
      leads,
      ([messageId, { lead }]) =>
        orderRepository.store(lead).pipe(
          Effect.retry({
            ...retryPolicy(config),
            while: (error) => error instanceof AuthenticationFailed || error instanceof OrderStoreTimedOut,
          }),
          Effect.timeout(Duration.millis(config.leadProcessingTimeout)),
          Effect.matchEffect({
            onFailure: (reason) =>
              Ref.update(unhandledMessageIDs, (current) => new Map(current).set(messageId, reason)),
            onSuccess: () =>
              Ref.update(unhandledMessageIDs, (current) => {
                const remaining = new Map(current);
                remaining.delete(messageId);
                return remaining;
              }),
          })
        ),
      { concurrency: config.leadInternalConcurrency, discard: true }
    ).pipe(Effect.exit);

    // A defect interrupts the other stores, so a message without a reason of its own takes the defect as its reason.
    const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    const unhandled = yield* Ref.get(unhandledMessageIDs);

    yield* Effect.forEach(
      requests,
      ([requestID, messages]) => {
        const failed = messages.filter(([messageId]) => unhandled.has(messageId)).length;
        return progress.record(requestID, leadBatchEnded({ processed: messages.length - failed, failed }));
      },
      { concurrency: config.leadInternalConcurrency, discard: true }
    );

    const notHandled = [...unhandled, ...leadRejections.map(({ messageId, error }) => [messageId, error] as const)].map(
      ([messageId, reason]) => new LeadNotHandled({ messageId, reason: reason ?? defect })
    );
    // The DLQ message does not carry the reason, so the log is the only record of why.
    yield* Effect.forEach(notHandled, (error) => Effect.logError(error), { discard: true });
    return notHandled;
  });
}
