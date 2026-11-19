import { RequestID, type RequestEntry } from '@leads/shared/domain/request';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { makeRequestFeed, stateOf, stateWith, toView, waitingOf, type FeedEvent } from './requests';

const now = new Date('2026-10-12T10:00:00.000Z');

/** A change can set an optional field to `undefined`, to remove it from the entry. */
type Change = { readonly [K in keyof RequestEntry]?: RequestEntry[K] | undefined };

const entry = (requestID: string, change: Change = {}): RequestEntry =>
  Object.fromEntries(
    Object.entries({
      requestID: RequestID.make(requestID),
      receivedAt: new Date('2026-10-12T09:59:00.000Z'),
      updatedAt: new Date('2026-10-12T09:59:30.000Z'),
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
      ...change,
    }).filter(([, value]) => value !== undefined)
  ) as RequestEntry;

describe('stateOf', () => {
  test.each<[string, Change, ReturnType<typeof stateOf>]>([
    ['every stage ended without a problem', {}, 'done'],
    ['the inbox handler did not end', { inboxStatus: 'pending', attachments: undefined }, 'active'],
    ['a source waits in the queue', { attachments: 2 }, 'active'],
    ['a source handler runs', { sourcesPending: 1, sourcesProcessed: 0 }, 'active'],
    ['a lead waits in the queue', { sourcesLeads: 3 }, 'active'],
    ['a lead handler runs', { leadsPending: 2, leadsProcessed: 0 }, 'active'],
    ['a lead failed', { leadsProcessed: 1, leadsFailed: 1 }, 'failed'],
    [
      'the email failed',
      { inboxStatus: 'failed', attachments: undefined, sourcesProcessed: 0, sourcesLeads: 0 },
      'failed',
    ],
    [
      'the email was rejected',
      { inboxStatus: 'rejected', attachments: undefined, sourcesProcessed: 0, sourcesLeads: 0 },
      'rejected',
    ],
    [
      'a source was rejected and a lead failed',
      { attachments: 2, sourcesRejected: 1, leadsProcessed: 1, leadsFailed: 1 },
      'failed',
    ],
    ['a standalone source ended', { receivedAt: undefined, inboxStatus: undefined, attachments: undefined }, 'done'],
  ])('%s', (_, change, state) => {
    expect(stateOf(entry('id', change))).toBe(state);
  });
});

test('toView writes the dates as ISO strings and adds the queued counts', () => {
  expect(toView(entry('id', { attachments: 3, sourcesLeads: 5 }))).toMatchObject({
    requestID: 'id',
    receivedAt: '2026-10-12T09:59:00.000Z',
    updatedAt: '2026-10-12T09:59:30.000Z',
    sourcesInQueue: 2,
    leadsInQueue: 3,
    state: 'active',
  });
  expect(toView(entry('id', { receivedAt: undefined, attachments: undefined }))).not.toHaveProperty('sourcesInQueue');
});

describe('waitingOf', () => {
  test('without DLQ messages, every waiting message is in the queue', () => {
    expect(waitingOf(toView(entry('id', { attachments: 3, sourcesLeads: 5 })))).toEqual({
      inboxInDlq: false,
      sourcesInQueue: 2,
      sourcesInDlq: 0,
      leadsInQueue: 3,
      leadsInDlq: 0,
    });
  });

  test('takes the DLQ messages of each stage out of the queue of that stage', () => {
    const view = toView(entry('id', { attachments: 3, sourcesLeads: 5 }));

    expect(waitingOf(view, { leadSources: 1, leads: 2 })).toMatchObject({
      sourcesInQueue: 1,
      sourcesInDlq: 1,
      leadsInQueue: 1,
      leadsInDlq: 2,
    });
  });

  test('does not count a DLQ message of a failure that the ledger counts', () => {
    const view = toView(entry('id', { sourcesLeads: 3, leadsProcessed: 1, leadsFailed: 1 }));

    expect(waitingOf(view, { leads: 2 })).toMatchObject({ leadsInQueue: 0, leadsInDlq: 1 });
  });

  test('ignores a queue that the ledger counts below 0 after a redrive', () => {
    const view = toView(entry('id', { sourcesLeads: 2, leadsProcessed: 2, leadsFailed: 1 }));

    expect(waitingOf(view, { leads: 1 })).toMatchObject({ leadsInQueue: 0, leadsInDlq: 0 });
  });

  test('puts a pending email in the DLQ only when the inbox DLQ names the request', () => {
    const view = toView(entry('id', { inboxStatus: 'pending', attachments: undefined, sourcesProcessed: 0 }));

    expect(waitingOf(view).inboxInDlq).toBe(false);
    expect(waitingOf(view, { inbox: 1 }).inboxInDlq).toBe(true);
    expect(waitingOf(toView(entry('id')), { inbox: 1 }).inboxInDlq).toBe(false);
  });
});

describe('stateWith', () => {
  const stateOfEntry = (change: Change, deadLetters = {}) => {
    const view = toView(entry('id', change));
    return stateWith(view, waitingOf(view, deadLetters));
  };

  test.each<[string, Change, object, ReturnType<typeof stateOf>]>([
    ['a lead waits in the queue', { sourcesLeads: 3 }, {}, 'active'],
    ['the only waiting lead is in the DLQ', { sourcesLeads: 3 }, { leads: 1 }, 'failed'],
    ['a lead is in the DLQ and another waits in the queue', { sourcesLeads: 4 }, { leads: 1 }, 'active'],
    ['a lead is in the DLQ and a lead handler runs', { sourcesLeads: 4, leadsPending: 1 }, { leads: 1 }, 'active'],
    ['the only waiting source is in the DLQ', { attachments: 2 }, { leadSources: 1 }, 'failed'],
    [
      'the email is in the DLQ',
      { inboxStatus: 'pending', attachments: undefined, sourcesProcessed: 0, sourcesLeads: 0, leadsProcessed: 0 },
      { inbox: 1 },
      'failed',
    ],
    ['a request that ended keeps its state', { leadsProcessed: 1, leadsRejected: 1 }, { leads: 1 }, 'rejected'],
  ])('%s', (_, change, deadLetters, state) => {
    expect(stateOfEntry(change, deadLetters)).toBe(state);
  });
});

describe('makeRequestFeed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const options = { pollMs: 2_000, retentionMs: 3_600_000, overlapMs: 10_000 };

  function feedOf(results: (readonly RequestEntry[] | Error)[]) {
    const changedSince = vi.fn(async (_since: Date) => {
      const result = results.shift() ?? [];
      if (result instanceof Error) throw result;
      return result;
    });
    const feed = makeRequestFeed({ ...options, changedSince });
    const events: FeedEvent[] = [];
    const unsubscribe = feed.subscribe((event) => events.push(event));
    return { feed, changedSince, events, unsubscribe };
  }

  const entriesOf = (events: FeedEvent[]) =>
    events.flatMap((event) => (event.type === 'entries' ? [event.entries.map((view) => view.requestID)] : []));

  test('reads the entries of the retention time first, then from the newest change minus the overlap', async () => {
    const { changedSince } = feedOf([[entry('a')], []]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(options.pollMs);

    expect(changedSince.mock.calls.map(([since]) => since.toISOString())).toEqual([
      '2026-10-12T09:00:00.000Z',
      '2026-10-12T09:59:20.000Z',
    ]);
  });

  test('sends only the entries that are new or changed', async () => {
    const changed = entry('a', { leadsPending: 1, leadsProcessed: 1, updatedAt: new Date('2026-10-12T09:59:40.000Z') });
    const { events } = feedOf([
      [entry('a'), entry('b')],
      [entry('a'), entry('b')],
      [changed, entry('b')],
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2 * options.pollMs);

    expect(entriesOf(events)).toEqual([[], ['a', 'b'], ['a']]);
  });

  test('keeps the newer state when a scan shows an older one', async () => {
    const newer = entry('a', { updatedAt: new Date('2026-10-12T09:59:40.000Z') });
    const { events } = feedOf([[newer], [entry('a', { leadsPending: 1, leadsProcessed: 1 })]]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(options.pollMs);

    expect(entriesOf(events)).toEqual([[], ['a']]);
  });

  test('gives a new listener every entry that it holds and the last status', async () => {
    const { feed } = feedOf([[entry('a'), entry('b')]]);
    await vi.advanceTimersByTimeAsync(0);

    const events: FeedEvent[] = [];
    feed.subscribe((event) => events.push(event));

    expect(entriesOf(events)).toEqual([['a', 'b']]);
    expect(events[1]).toEqual({ type: 'status', ok: true, readAt: now.toISOString() });
  });

  test('sends the error of a failed poll with the time of the last good read, and polls again', async () => {
    const { events, changedSince } = feedOf([[], new Error('The security token expired'), [entry('a')]]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(options.pollMs);

    expect(events.at(-1)).toEqual({
      type: 'status',
      ok: false,
      error: 'The security token expired',
      readAt: now.toISOString(),
    });

    await vi.advanceTimersByTimeAsync(options.pollMs);
    expect(changedSince).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toMatchObject({ type: 'status', ok: true });
  });

  test('forgets the entries older than the retention time', async () => {
    const { feed } = feedOf([[entry('a')], []]);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(new Date(now.getTime() + options.retentionMs));
    await vi.advanceTimersByTimeAsync(options.pollMs);

    const events: FeedEvent[] = [];
    feed.subscribe((event) => events.push(event));
    expect(entriesOf(events)).toEqual([[]]);
  });

  test('counts the polls and the read units of each poll, also of a failed poll', async () => {
    let units = 0;
    const scans = [3, new Error('Throttled'), 4];
    const changedSince = vi.fn(async () => {
      const scan = scans.shift() ?? 0;
      units += scan instanceof Error ? 1 : scan;
      if (scan instanceof Error) throw scan;
      return [];
    });
    const feed = makeRequestFeed({ ...options, changedSince, readUnits: () => units });
    const events: FeedEvent[] = [];
    feed.subscribe((event) => events.push(event));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2 * options.pollMs);

    const reads = events.flatMap((event) =>
      event.type === 'status' && event.reads !== undefined ? [event.reads] : []
    );
    expect(reads).toEqual([
      { since: now.toISOString(), polls: 1, readUnits: 3, lastReadUnits: 3 },
      { since: now.toISOString(), polls: 2, readUnits: 4, lastReadUnits: 1 },
      { since: now.toISOString(), polls: 3, readUnits: 8, lastReadUnits: 4 },
    ]);
  });

  test('stops after the last listener leaves and starts again for a new listener', async () => {
    const { feed, changedSince, unsubscribe } = feedOf([]);
    await vi.advanceTimersByTimeAsync(0);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(10 * options.pollMs);
    expect(changedSince).toHaveBeenCalledOnce();

    feed.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(changedSince).toHaveBeenCalledTimes(2);
  });
});
