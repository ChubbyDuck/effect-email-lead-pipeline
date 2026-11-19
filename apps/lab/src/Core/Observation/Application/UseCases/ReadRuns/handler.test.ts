import { RequestID, type RequestEntry } from '@leads/shared/domain/request';
import { describe, expect, test } from 'vitest';

import { requestDetailsOf } from '#Core/Observation/Domain/details';
import { toView } from '#Core/Observation/Domain/requests';
import type { RequestRuns } from '#Core/Observation/Domain/runs';
import type { RequestEntrySource } from '#Core/Observation/Ports/RequestEntrySource';
import { logGroupOf, makeLogSearch } from '#Core/Observation/Ports/testing/logSearch';

import { handler } from './handler';

const requestID = 'ntls5k1165jcg1a8otpg8kcqrsva6q18lk7ond81';
const receivedAt = Date.parse('2026-10-16T11:49:21.796Z');
const now = receivedAt + 600_000;

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

const from = new Date(receivedAt - 120_000);
const to = new Date(receivedAt + 52_300 + 120_000);

const requestRuns: RequestRuns = {
  requestID,
  deployment: 'production-cdk',
  region: 'eu-north-1',
  from: from.toISOString(),
  to: to.toISOString(),
  readAt: new Date(now).toISOString(),
  stages: {
    inbox: { ok: true, value: { logGroup: logGroupOf('inbox'), runs: [], more: false } },
    leadSources: { ok: true, value: { logGroup: logGroupOf('leadSources'), runs: [], more: false } },
    leads: { ok: false, error: 'Error: throttled' },
  },
};

const entriesOf = (entry: RequestEntry | undefined): RequestEntrySource => ({ entryOf: async () => entry });

describe('ReadRuns', () => {
  test('gives the details of the entry and of the runs in the search window of the entry', async () => {
    const { logs, searches } = makeLogSearch({ failing: ['leads'] });

    const result = await handler({ entries: entriesOf(stored), logs }, { requestID, now });

    expect(result).toEqual({ ok: true, details: requestDetailsOf(toView(stored), requestRuns) });
    expect(searches.map((search) => ({ from: search.from, to: search.to }))).toEqual([
      { from, to },
      { from, to },
      { from, to },
    ]);
  });

  test('says that the ledger has no entry, and reads no runs', async () => {
    const { logs, searches } = makeLogSearch({});

    const result = await handler({ entries: entriesOf(undefined), logs }, { requestID, now });

    expect(result).toEqual({
      ok: false,
      error: `The ledger has no entry for ${requestID}. It deletes an entry one week after its last change.`,
    });
    expect(searches).toEqual([]);
  });
});
