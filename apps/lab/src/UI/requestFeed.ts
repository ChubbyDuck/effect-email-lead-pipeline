/**
 * What the page knows of the request ledger. The stream sends only new and changed entries, so the page keeps every
 * entry that it got, by request ID.
 */
import type { DeadLetterCounts } from '#Core/Observation/Domain/dlq';
import {
  type FeedEvent,
  type RequestState,
  type RequestView,
  stalledAfterSeconds,
  stateWith,
  waitingOf,
} from '#Core/Observation/Domain/requests';

import type { Tone } from './Tag';

export type LedgerStatus = Extract<FeedEvent, { type: 'status' }>;

export interface FeedState {
  readonly requests: ReadonlyMap<string, RequestView>;
  /** How many times each request changed after the first load. A row flashes after each change. */
  readonly changes: ReadonlyMap<string, number>;
  /** The stream reconnects by itself after it closes. A paused page has no stream. */
  readonly connection: 'connecting' | 'open' | 'closed' | 'paused';
  /** The result of the last poll of the server. */
  readonly status?: LedgerStatus;
  /** True after the first poll. Before it, the page does not know which requests there are. */
  readonly loaded: boolean;
}

export type FeedAction =
  | FeedEvent
  | { readonly type: 'open' }
  | { readonly type: 'closed' }
  | { readonly type: 'paused' }
  | { readonly type: 'resumed' };

export const initialFeed: FeedState = {
  requests: new Map(),
  changes: new Map(),
  connection: 'connecting',
  loaded: false,
};

export function reduceFeed(state: FeedState, action: FeedAction): FeedState {
  switch (action.type) {
    case 'open':
      return { ...state, connection: 'open' };
    case 'closed':
      return state.connection === 'paused' ? state : { ...state, connection: 'closed' };
    case 'paused':
      return { ...state, connection: 'paused' };
    case 'resumed':
      return { ...state, connection: 'connecting' };
    case 'status':
      return { ...state, status: action, loaded: state.loaded || action.ok };
    case 'entries': {
      const requests = new Map(state.requests);
      const changes = new Map(state.changes);
      for (const entry of action.entries) {
        const known = requests.get(entry.requestID);
        if (known !== undefined && JSON.stringify(known) === JSON.stringify(entry)) continue;
        // The first event of a new stream has every entry. Only a real change flashes.
        if (state.loaded) changes.set(entry.requestID, (changes.get(entry.requestID) ?? 0) + 1);
        requests.set(entry.requestID, entry);
      }
      return { ...state, requests, changes, loaded: state.loaded || state.status !== undefined };
    }
  }
}

/** The state that the page shows: an active request without a change for too long is stalled. */
export type ShownState = RequestState | 'stalled';

/** The state of a request in the words and the color of the page. */
export const stateText: Record<ShownState, readonly [tone: Tone, text: string]> = {
  active: ['info', 'in progress'],
  stalled: ['warning', 'stalled'],
  failed: ['critical', 'has failures'],
  rejected: ['warning', 'has rejections'],
  done: ['ok', 'done'],
};

/** With the DLQ messages of the request, a request whose work waits only in the DLQs has failed. */
export function shownStateOf(request: RequestView, now: number, deadLetters?: DeadLetterCounts): ShownState {
  const state = stateWith(request, waitingOf(request, deadLetters));
  return state === 'active' && now - Date.parse(request.updatedAt) > stalledAfterSeconds * 1000 ? 'stalled' : state;
}

/** The requests that changed in the window, the newest first. */
export const requestsInWindow = (state: FeedState, windowHours: number, now: number): RequestView[] =>
  [...state.requests.values()]
    .filter((request) => Date.parse(request.updatedAt) >= now - windowHours * 3_600_000)
    .toSorted((a, b) => (b.receivedAt ?? b.updatedAt).localeCompare(a.receivedAt ?? a.updatedAt));

/** The chip that shows the connection to the request ledger. */
export function liveOf(state: FeedState): { readonly level?: string; readonly text: string } {
  if (state.connection === 'paused') return { text: 'paused' };
  if (state.connection === 'closed') return { level: 'warning', text: 'reconnecting' };
  if (state.connection === 'connecting' || state.status === undefined) return { text: 'connecting' };
  if (state.status.ok) return { level: 'ok', text: 'live' };
  return { level: 'critical', text: 'cannot read' };
}

/** The newest change in the ledger. The handlers write the ledger as they work, so it is the time of the last activity. */
export const lastChangeOf = (state: FeedState): string | undefined =>
  [...state.requests.values()].reduce<string | undefined>(
    (newest, { updatedAt }) => (newest === undefined || updatedAt > newest ? updatedAt : newest),
    undefined
  );
