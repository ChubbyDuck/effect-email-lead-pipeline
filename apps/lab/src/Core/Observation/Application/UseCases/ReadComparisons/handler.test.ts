import { RequestID, type RequestEntry } from '@leads/shared/domain/request';
import { describe, expect, test } from 'vitest';

import type { RequestEntrySource } from '#Core/Observation/Ports/RequestEntrySource';
import { makeLogSearch } from '#Core/Observation/Ports/testing/logSearch';

import { handler, readLimit } from './handler';

const requestID = 'ntls5k1165jcg1a8otpg8kcqrsva6q18lk7ond81';
const receivedAt = Date.parse('2026-10-16T11:49:21.796Z');

const stored: RequestEntry = {
  requestID: RequestID.make(requestID),
  receivedAt: new Date(receivedAt),
  updatedAt: new Date(receivedAt + 52_300),
  inboxStatus: 'processed',
  attachments: 3,
  sourcesPending: 0,
  sourcesProcessed: 3,
  sourcesRejected: 0,
  sourcesFailed: 0,
  sourcesLeads: 15,
  leadsPending: 0,
  leadsProcessed: 15,
  leadsRejected: 0,
  leadsFailed: 0,
};

/** A log search without lines. It keeps the time of each search. */
function fakeLogs() {
  const { logs, searches } = makeLogSearch({});
  return {
    logs,
    windows: () => [...new Set(searches.map(({ from, to }) => `${from.toISOString()} ${to.toISOString()}`))],
  };
}

const windowOf = (from: number, to: number) => `${new Date(from).toISOString()} ${new Date(to).toISOString()}`;

const entriesOf = (entry: RequestEntry | undefined): RequestEntrySource => ({ entryOf: async () => entry });

describe('ReadComparisons', () => {
  test('reads the entry, then the runs in the search window of the entry', async () => {
    const { logs, windows } = fakeLogs();

    const reads = await handler(
      { entries: entriesOf(stored), logs },
      { requestIDs: [requestID], now: receivedAt + 600_000 }
    );

    expect(reads).toMatchObject([
      {
        requestID,
        result: {
          ok: true,
          entry: { requestID, attachments: 3, state: 'done' },
          runs: { requestID, readAt: new Date(receivedAt + 600_000).toISOString() },
        },
      },
    ]);
    expect(windows()).toEqual([windowOf(receivedAt - 120_000, receivedAt + 52_300 + 120_000)]);
  });

  test('searches until now while the request is active', async () => {
    const { logs, windows } = fakeLogs();
    const now = receivedAt + 600_000;

    await handler(
      { entries: entriesOf({ ...stored, leadsPending: 5, leadsProcessed: 10 }), logs },
      { requestIDs: [requestID], now }
    );

    expect(windows()).toEqual([windowOf(receivedAt - 120_000, now)]);
  });

  test('says that the ledger has no entry, and reads no runs', async () => {
    const { logs, windows } = fakeLogs();

    const reads = await handler({ entries: entriesOf(undefined), logs }, { requestIDs: [requestID], now: receivedAt });

    expect(reads).toEqual([
      {
        requestID,
        result: {
          ok: false,
          error: `The ledger has no entry for ${requestID}. It deletes an entry one week after its last change.`,
        },
      },
    ]);
    expect(windows()).toEqual([]);
  });

  test('keeps a failed read to its own request', async () => {
    const { logs } = fakeLogs();
    const entries: RequestEntrySource = {
      entryOf: async (id) => {
        if (id === 'broken') throw new Error('ledger down');
        return stored;
      },
    };

    const reads = await handler({ entries, logs }, { requestIDs: ['first', 'broken', 'last'], now: receivedAt });

    expect(reads.map((read) => read.requestID)).toEqual(['first', 'broken', 'last']);
    expect(reads.map(({ result }) => result.ok)).toEqual([true, false, true]);
    expect(reads[1]?.result).toEqual({ ok: false, error: 'ledger down' });
  });

  test('keeps the order of the list, and never reads more than the limit at one time', async () => {
    const { logs } = fakeLogs();
    let reading = 0;
    let most = 0;
    const entries: RequestEntrySource = {
      entryOf: async () => {
        reading += 1;
        most = Math.max(most, reading);
        await new Promise((done) => setTimeout(done, 1));
        reading -= 1;
        return stored;
      },
    };
    const requestIDs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

    const reads = await handler({ entries, logs }, { requestIDs, now: receivedAt });

    expect(reads.map((read) => read.requestID)).toEqual(requestIDs);
    expect(most).toBe(readLimit);
  });

  test('reads nothing for an empty list', async () => {
    const { logs, windows } = fakeLogs();

    expect(await handler({ entries: entriesOf(stored), logs }, { requestIDs: [], now: receivedAt })).toEqual([]);
    expect(windows()).toEqual([]);
  });
});
