import type { FeedListener } from '#Core/Observation/Domain/requests';

/** The port that gives the events of the request ledger to its listeners. */
export interface RequestFeed {
  /** Returns the call that ends the subscription. */
  readonly subscribe: (listener: FeedListener) => () => void;
}
