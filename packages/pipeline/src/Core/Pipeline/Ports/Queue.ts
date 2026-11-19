import type { RequestID } from '@leads/shared/domain/request';
import type { Lead } from '@leads/shared/domain/types';
import { withReason } from '@leads/shared/utils';
import { Context, Data, type Effect } from 'effect';

import type { QueuedLead } from '#Core/Pipeline/Domain/queuedLead';

export class MessageNotPushed extends Data.TaggedError('MessageNotPushed')<{
  readonly requestID: RequestID;
  readonly lead: Lead;
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason(`Message of request ${this.requestID} could not be pushed to a queue`, this.reason);
  }
}

export class MessageBatchNotPushed extends Data.TaggedError('MessageBatchNotPushed')<{
  readonly failures: readonly MessageNotPushed[];
}> {
  override get message(): string {
    return `Message batch not pushed: ${this.failures.map((failure) => failure.message).join(', ')}`;
  }
}

export class Queue extends Context.Service<
  Queue,
  {
    /** Pushes at most `QueueBatchSize` messages; fails with only the messages that were not pushed. */
    readonly pushBatch: (messages: readonly QueuedLead[]) => Effect.Effect<void, MessageBatchNotPushed>;
  }
>()('@leads/pipeline/Core/Pipeline/Ports/Queue') {}
