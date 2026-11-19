import type { Lead } from '@leads/shared/domain/types';
import { Context, Data, type Effect } from 'effect';

const withReason = (message: string, reason: unknown) =>
  reason instanceof Error ? `${message} due to: ${reason.message}` : message;

export class AuthenticationFailed extends Data.TaggedError('AuthenticationFailed')<{
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason('Authentication failed', this.reason);
  }
}

export class OrderStoreTimedOut extends Data.TaggedError('OrderStoreTimedOut')<{
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason('Order store timed out', this.reason);
  }
}

export class OrderStoreFailed extends Data.TaggedError('OrderStoreFailed')<{
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason('Order store failed', this.reason);
  }
}

export class OrderRepository extends Context.Service<
  OrderRepository,
  {
    readonly store: (
      content: Lead
    ) => Effect.Effect<void, AuthenticationFailed | OrderStoreTimedOut | OrderStoreFailed>;
  }
>()('@leads/pipeline/Core/Pipeline/Ports/OrderRepository') {}
