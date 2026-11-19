import { RequestID } from '@leads/shared/domain/request';
import { describe, expect, test } from 'vitest';

import { type RequestView, stalledAfterSeconds } from '#Core/Observation/Domain/requests';

import {
  type FeedAction,
  initialFeed,
  lastChangeOf,
  liveOf,
  reduceFeed,
  requestsInWindow,
  shownStateOf,
} from './requestFeed';

const now = Date.parse('2026-10-12T10:00:00.000Z');

const view = (requestID: string, change: Partial<RequestView> = {}): RequestView => ({
  requestID: RequestID.make(requestID),
  receivedAt: '2026-10-12T09:59:00.000Z',
  updatedAt: '2026-10-12T09:59:30.000Z',
  inboxStatus: 'processed',
  attachments: 1,
  sourcesPending: 0,
  sourcesProcessed: 1,
  sourcesRejected: 0,
  sourcesFailed: 0,
  sourcesLeads: 2,
  leadsPending: 0,
  leadsProcessed: 2,
  leadsRejected: 0,
  leadsFailed: 0,
  sourcesInQueue: 0,
  leadsInQueue: 0,
  state: 'done',
  ...change,
});

const ok = { type: 'status', ok: true, readAt: '2026-10-12T10:00:00.000Z' } as const;

const reduce = (...actions: readonly FeedAction[]) => actions.reduce(reduceFeed, initialFeed);

describe('reduceFeed', () => {
  test('keeps a paused feed paused when its stream closes, and connects again after a resume', () => {
    const paused = reduce({ type: 'open' }, ok, { type: 'paused' }, { type: 'closed' });

    expect(paused.connection).toBe('paused');
    expect(liveOf(paused)).toEqual({ text: 'paused' });
    expect(reduceFeed(paused, { type: 'resumed' }).connection).toBe('connecting');
  });

  test('does not flash the entries that come before the first poll', () => {
    const state = reduce({ type: 'entries', entries: [view('a')] }, ok);

    expect([...state.requests.keys()]).toEqual(['a']);
    expect(state.changes.size).toBe(0);
    expect(state.loaded).toBe(true);
  });

  test('flashes each real change after the first poll', () => {
    const state = reduce(
      { type: 'entries', entries: [view('a')] },
      ok,
      { type: 'entries', entries: [view('a', { leadsProcessed: 1 }), view('b')] },
      { type: 'entries', entries: [view('a', { leadsProcessed: 2 })] }
    );

    expect(state.changes).toEqual(
      new Map([
        ['a', 2],
        ['b', 1],
      ])
    );
    expect(state.requests.get('a')?.leadsProcessed).toBe(2);
  });

  test('does not flash an entry that a new stream sends again unchanged', () => {
    const state = reduce(
      { type: 'entries', entries: [view('a')] },
      ok,
      { type: 'closed' },
      { type: 'open' },
      { type: 'entries', entries: [view('a')] }
    );

    expect(state.changes.size).toBe(0);
  });

  test('stays not loaded while the ledger cannot be read', () => {
    const state = reduce({ type: 'entries', entries: [] }, { type: 'status', ok: false, error: 'No table' });

    expect(state.loaded).toBe(false);
    expect(liveOf(reduceFeed(state, { type: 'open' }))).toEqual({ level: 'critical', text: 'cannot read' });
  });
});

describe('liveOf', () => {
  test.each([
    [[], 'connecting'],
    [[{ type: 'open' }], 'connecting'],
    [[{ type: 'open' }, ok], 'live'],
    [[{ type: 'open' }, ok, { type: 'closed' }], 'reconnecting'],
  ] as const)('after %j shows %s', (actions, text) => {
    expect(liveOf(reduce(...actions)).text).toBe(text);
  });
});

test('shows an active request without a change for too long as stalled', () => {
  const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  expect(shownStateOf(view('a', { state: 'active', updatedAt: at(stalledAfterSeconds - 1) }), now)).toBe('active');
  expect(shownStateOf(view('a', { state: 'active', updatedAt: at(stalledAfterSeconds + 1) }), now)).toBe('stalled');
  expect(shownStateOf(view('a', { state: 'failed', updatedAt: at(stalledAfterSeconds + 1) }), now)).toBe('failed');
});

test('shows an active request whose work waits only in a DLQ as failed, never as stalled', () => {
  const old = new Date(now - (stalledAfterSeconds + 1) * 1000).toISOString();
  const request = view('a', { state: 'active', updatedAt: old, sourcesLeads: 3, leadsInQueue: 1 });

  expect(shownStateOf(request, now)).toBe('stalled');
  expect(shownStateOf(request, now, { leads: 1 })).toBe('failed');
});

test('lists the requests of the window, the newest received first', () => {
  const state = reduce(ok, {
    type: 'entries',
    entries: [
      view('old', { updatedAt: '2026-10-12T08:30:00.000Z' }),
      view('first', { receivedAt: '2026-10-12T09:10:00.000Z' }),
      view('second', { receivedAt: '2026-10-12T09:20:00.000Z' }),
    ],
  });

  expect(requestsInWindow(state, 1, now).map((request) => request.requestID)).toEqual(['second', 'first']);
});

describe('lastChangeOf', () => {
  test('gives the newest change of all requests', () => {
    const state = reduce(
      {
        type: 'entries',
        entries: [
          view('a', { updatedAt: '2026-10-12T09:59:30.000Z' }),
          view('b', { updatedAt: '2026-10-12T09:59:50.000Z' }),
          view('c', { updatedAt: '2026-10-12T09:58:00.000Z' }),
        ],
      },
      ok
    );

    expect(lastChangeOf(state)).toBe('2026-10-12T09:59:50.000Z');
  });

  test('gives no change before the ledger has requests', () => {
    expect(lastChangeOf(initialFeed)).toBeUndefined();
  });
});
