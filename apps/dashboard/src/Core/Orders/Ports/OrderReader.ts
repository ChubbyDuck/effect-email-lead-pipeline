import { withReason } from '@leads/shared/utils';
import { Context, Data, type Effect } from 'effect';

import type { OrderRead } from '#Core/Orders/Domain/order';

export class OrdersNotRead extends Data.TaggedError('OrdersNotRead')<{
  readonly reason: unknown;
  /** The AWS credentials are missing or expired, so a new sign-in fixes the read. */
  readonly authentication: boolean;
  /** The key of the stored item that did not decode, when one item failed the read. */
  readonly key?: string;
}> {
  override get message(): string {
    return withReason(this.key === undefined ? 'Orders not read' : `Order ${this.key} not read`, this.reason);
  }
}

/** Reads the orders that the lead handler stored. It is apart from `OrderRepository`, so the lead handler gets no read. */
export class OrderReader extends Context.Service<
  OrderReader,
  {
    /** Reads every stored order, in no fixed order. */
    readonly all: Effect.Effect<OrderRead, OrdersNotRead>;
  }
>()('@leads/dashboard/Core/Orders/Ports/OrderReader') {}
