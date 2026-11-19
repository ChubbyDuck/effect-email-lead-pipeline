import type { RequestEntry } from '@leads/shared/domain/request';

/** The port that reads the entry of one request in the ledger. */
export interface RequestEntrySource {
  /** The entry of one request, or none. */
  readonly entryOf: (requestID: string) => Promise<RequestEntry | undefined>;
}
