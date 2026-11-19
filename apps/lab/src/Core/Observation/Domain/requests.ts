/**
 * The live view of the request ledger. One feed polls the ledger for the entries that changed and sends only those to
 * each page, so a page sees a change about one poll after a handler writes it.
 */
import { leadsInQueue, type RequestEntry, sourcesInQueue } from '@leads/shared/domain/request';

import type { DeadLetterCounts } from './dlq';

/**
 * Where a request stands, as the lab shows it. A request is active while a stage still has its email, sources, or
 * leads. After that, a failure counts before a rejection.
 */
export type RequestState = 'active' | 'failed' | 'rejected' | 'done';

/** An active request without a change for this time probably lost a message. The page shows it as stalled. */
export const stalledAfterSeconds = 15 * 60;

/** A request entry with its dates as ISO strings and the values that the page shows but the ledger does not keep. */
export interface RequestView extends Omit<RequestEntry, 'receivedAt' | 'updatedAt'> {
  readonly receivedAt?: string;
  readonly updatedAt: string;
  /** Not known before the inbox handler counts the attachments. */
  readonly sourcesInQueue?: number;
  readonly leadsInQueue: number;
  readonly state: RequestState;
}

export function stateOf(entry: RequestEntry): RequestState {
  const queued = (sourcesInQueue(entry) ?? 0) + leadsInQueue(entry);
  if (entry.inboxStatus === 'pending' || entry.sourcesPending > 0 || entry.leadsPending > 0 || queued > 0) {
    return 'active';
  }
  if (entry.inboxStatus === 'failed' || entry.sourcesFailed > 0 || entry.leadsFailed > 0) return 'failed';
  if (entry.inboxStatus === 'rejected' || entry.sourcesRejected > 0 || entry.leadsRejected > 0) return 'rejected';
  return 'done';
}

/** Where the work of a request waits that no handler took: in the main queue of its stage, or in the DLQ. */
export interface Waiting {
  /** The email went to the DLQ before the inbox handler ended it. */
  readonly inboxInDlq: boolean;
  /** Not known before the inbox handler counts the attachments. */
  readonly sourcesInQueue?: number;
  readonly sourcesInDlq: number;
  readonly leadsInQueue: number;
  readonly leadsInDlq: number;
}

/**
 * The ledger does not know the DLQs. A message that goes to a DLQ before its handler writes a change stays in the
 * queue for the ledger, so the messages in the DLQ of a stage come out of the queue of that stage. A failure that the
 * ledger counts also has its message in the DLQ, so the queue limits the count of the DLQ.
 */
export function waitingOf(view: RequestView, deadLetters: DeadLetterCounts = {}): Waiting {
  const split = (queued: number, inDlq = 0) => {
    const dlq = Math.min(Math.max(0, queued), inDlq);
    return [Math.max(0, queued) - dlq, dlq] as const;
  };
  const [sourcesInQueue, sourcesInDlq] = split(view.sourcesInQueue ?? 0, deadLetters.leadSources);
  const [leadsInQueue, leadsInDlq] = split(view.leadsInQueue, deadLetters.leads);
  return {
    inboxInDlq: view.inboxStatus === 'pending' && (deadLetters.inbox ?? 0) > 0,
    ...(view.sourcesInQueue !== undefined && { sourcesInQueue }),
    sourcesInDlq,
    leadsInQueue,
    leadsInDlq,
  };
}

/** An active request whose work waits only in the DLQs has failed: no handler takes it before a redrive. */
export function stateWith(view: RequestView, waiting: Waiting): RequestState {
  if (view.state !== 'active') return view.state;
  const working =
    (view.inboxStatus === 'pending' && !waiting.inboxInDlq) ||
    view.sourcesPending > 0 ||
    view.leadsPending > 0 ||
    (waiting.sourcesInQueue ?? 0) > 0 ||
    waiting.leadsInQueue > 0;
  const inDlq = waiting.inboxInDlq || waiting.sourcesInDlq > 0 || waiting.leadsInDlq > 0;
  return working || !inDlq ? 'active' : 'failed';
}

export function toView(entry: RequestEntry): RequestView {
  const { receivedAt, updatedAt, ...rest } = entry;
  const queuedSources = sourcesInQueue(entry);
  return {
    ...rest,
    ...(receivedAt !== undefined && { receivedAt: receivedAt.toISOString() }),
    updatedAt: updatedAt.toISOString(),
    ...(queuedSources !== undefined && { sourcesInQueue: queuedSources }),
    leadsInQueue: leadsInQueue(entry),
    state: stateOf(entry),
  };
}

/** What the polls of the feed read from the ledger since the server started. Each read unit costs money. */
export interface LedgerReads {
  readonly since: string;
  readonly polls: number;
  readonly readUnits: number;
  /** The read units of the last poll. A scan reads the whole table, so this grows with the ledger. */
  readonly lastReadUnits: number;
}

export type FeedEvent =
  /** The entries that are new or changed. The first event to a listener has every entry that the feed holds. */
  | { readonly type: 'entries'; readonly entries: readonly RequestView[] }
  /** The result of the last poll. `readAt` is the time of the last poll that succeeded. */
  | { readonly type: 'status'; readonly ok: true; readonly readAt: string; readonly reads?: LedgerReads }
  | {
      readonly type: 'status';
      readonly ok: false;
      readonly error: string;
      readonly readAt?: string;
      readonly reads?: LedgerReads;
    };

export type FeedListener = (event: FeedEvent) => void;

export interface RequestFeedOptions {
  readonly changedSince: (since: Date) => Promise<readonly RequestEntry[]>;
  /** In ms. The time from the end of one poll to the start of the next. */
  readonly pollMs: number;
  /** In ms. The feed holds the entries changed in this time before now, and forgets older entries. */
  readonly retentionMs: number;
  /**
   * In ms. Each poll reads again the entries changed in this time before the newest change that the feed saw. A change
   * that a scan shows late, or that a handler with a slow clock wrote, is then not lost.
   */
  readonly overlapMs: number;
  /** The read units that the ledger consumed since the server started. Without it, the feed reports no reads. */
  readonly readUnits?: () => number;
  readonly now?: () => Date;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Polls the ledger only while a listener is subscribed. Polls never overlap. */
export function makeRequestFeed({
  changedSince,
  pollMs,
  retentionMs,
  overlapMs,
  readUnits,
  now = () => new Date(),
}: RequestFeedOptions) {
  const started = now().toISOString();
  const views = new Map<string, RequestView>();
  const listeners = new Set<FeedListener>();
  /** The newest `updatedAt` that the feed saw, in ms. */
  let newest: number | undefined;
  let status: Extract<FeedEvent, { type: 'status' }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let reads: LedgerReads | undefined =
    readUnits === undefined ? undefined : { since: started, polls: 0, readUnits: 0, lastReadUnits: 0 };

  const emit = (event: FeedEvent) => listeners.forEach((listener) => listener(event));

  function take(entries: readonly RequestEntry[]) {
    const changed: RequestView[] = [];
    for (const entry of entries) {
      const view = toView(entry);
      const known = views.get(view.requestID);
      // A scan can show an older state of an entry after a newer one.
      if (known !== undefined && view.updatedAt < known.updatedAt) continue;
      if (known !== undefined && JSON.stringify(known) === JSON.stringify(view)) continue;
      views.set(view.requestID, view);
      changed.push(view);
    }
    for (const view of views.values()) newest = Math.max(newest ?? 0, Date.parse(view.updatedAt));
    return changed;
  }

  function forgetBefore(floor: number) {
    for (const [requestID, view] of views) if (Date.parse(view.updatedAt) < floor) views.delete(requestID);
  }

  async function poll() {
    timer = undefined;
    polling = true;
    const at = now();
    const floor = at.getTime() - retentionMs;
    const since = newest === undefined ? floor : Math.max(floor, newest - overlapMs);
    const unitsBefore = readUnits?.() ?? 0;
    // A failed poll can read too, so the feed counts every poll.
    const count = () => {
      if (reads === undefined || readUnits === undefined) return {};
      const total = readUnits();
      reads = { ...reads, polls: reads.polls + 1, readUnits: total, lastReadUnits: total - unitsBefore };
      return { reads };
    };
    try {
      const changed = take(await changedSince(new Date(since)));
      forgetBefore(floor);
      if (changed.length > 0) emit({ type: 'entries', entries: changed });
      status = { type: 'status', ok: true, readAt: at.toISOString(), ...count() };
    } catch (error) {
      const readAt = status?.readAt;
      status = {
        type: 'status',
        ok: false,
        error: messageOf(error),
        ...(readAt !== undefined && { readAt }),
        ...count(),
      };
    }
    emit(status);
    polling = false;
    if (listeners.size > 0) timer = setTimeout(poll, pollMs);
  }

  return {
    subscribe(listener: FeedListener) {
      listeners.add(listener);
      listener({ type: 'entries', entries: [...views.values()] });
      if (status !== undefined) listener(status);
      if (timer === undefined && !polling) void poll();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
      };
    },
  };
}
