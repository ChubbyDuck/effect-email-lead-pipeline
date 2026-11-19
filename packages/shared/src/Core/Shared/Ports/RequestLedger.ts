import { Context, Data, type Effect } from 'effect';

import type { Request, RequestEntry, RequestID, RequestProgress } from '#Core/Shared/Domain/request';

const withReason = (message: string, reason: unknown) =>
  reason instanceof Error ? `${message} due to: ${reason.message}` : message;

export class RequestNotAcknowledged extends Data.TaggedError('RequestNotAcknowledged')<{
  readonly request: Request;
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason(`Request not acknowledged: ${this.request.requestID}`, this.reason);
  }
}

export class RequestNotRecorded extends Data.TaggedError('RequestNotRecorded')<{
  readonly requestID: RequestID;
  readonly progress: RequestProgress;
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason(`Progress of request ${this.requestID} not recorded`, this.reason);
  }
}

export class RequestsNotListed extends Data.TaggedError('RequestsNotListed')<{
  readonly since: Date;
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason(`Requests changed since ${this.since.toISOString()} not listed`, this.reason);
  }
}

export class RequestNotRead extends Data.TaggedError('RequestNotRead')<{
  readonly requestID: RequestID;
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason(`Request ${this.requestID} not read`, this.reason);
  }
}

/** The book of every request that the system took in, with one entry for each request and its progress. */
export class RequestLedger extends Context.Service<
  RequestLedger,
  {
    /**
     * Enters the request in the ledger only if its ID is new. A second delivery of the same email keeps the first
     * entry, so its status does not go back to pending.
     */
    readonly acknowledge: (request: Request) => Effect.Effect<void, RequestNotAcknowledged>;
    /**
     * Applies one change to the entry of the request. The counter deltas add to the current counters, so the order of
     * the changes does not matter, and a change can come before the acknowledgement.
     */
    readonly record: (requestID: RequestID, progress: RequestProgress) => Effect.Effect<void, RequestNotRecorded>;
    /** Lists the entries whose last change is at or after `since`, in no fixed order. */
    readonly changedSince: (since: Date) => Effect.Effect<readonly RequestEntry[], RequestsNotListed>;
    /** Reads the entry of one request. No entry when the ledger has none: it deletes an entry one week after its last change. */
    readonly entryOf: (requestID: RequestID) => Effect.Effect<RequestEntry | undefined, RequestNotRead>;
  }
>()('@leads/shared/Core/Shared/Ports/RequestLedger') {}
