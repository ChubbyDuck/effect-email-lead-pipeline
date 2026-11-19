import { Effect } from 'effect';

import { decodeQueuedLead } from '#Core/Pipeline/Domain/queuedLead';

/** A message of the leads queue: its ID, so the message can go back to the queue, and its body. */
export type QueueRecord = { readonly messageId: string; readonly body: string };

export const toLeadsAndRejectionsFromRecords = (records: ReadonlyArray<QueueRecord>) =>
  Effect.gen(function* () {
    const [leads, leadRejections] = yield* Effect.partition(records, (record, index) =>
      decodeQueuedLead(record.body).pipe(
        Effect.map((body) => [record.messageId, body] as const),
        Effect.mapError((error) => ({ index, messageId: record.messageId, input: record, error }))
      )
    );
    return { leads: new Map(leads), leadRejections };
  });
