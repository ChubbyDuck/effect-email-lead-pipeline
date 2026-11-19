import type { RequestFeed } from '#Core/Observation/Ports/RequestFeed';

import type { Command } from './command';

export type Ports = {
  readonly requests: RequestFeed;
};

/** Gives the events of the request ledger to the listener. Returns the call that stops them. */
export function handler({ requests }: Ports, { listener }: Command): () => void {
  return requests.subscribe(listener);
}
