import { describe, expect, test } from 'vitest';

import { runsPrice } from './costs';
import { changedAfterRead, requestDetailsOf, tallyOf } from './details';
import { requestCostOf } from './requestCost';
import type { RequestView } from './requests';
import type { HandlerRun, RequestRuns, StageRuns } from './runs';
import type { Section } from './snapshot';

const requestID = 'ntls5k1165jcg1a8otpg8kcqrsva6q18lk7ond81';
const receivedAt = Date.parse('2026-10-16T11:49:21.796Z');
const iso = (ms: number) => new Date(receivedAt + ms).toISOString();

const run = (stage: HandlerRun['stage'], runID: string, startMs: number, durationMs?: number): HandlerRun => ({
  stage,
  runID,
  logStream: 'stream',
  startedAt: iso(startMs),
  ...(durationMs !== undefined && {
    endedAt: iso(startMs + durationMs),
    durationMs,
    billedMs: durationMs,
    memoryMb: 128,
  }),
  outcome: durationMs === undefined ? 'running' : 'ended',
  errors: 0,
  warnings: 0,
  otherRequests: 0,
  logBytes: 800,
  lines: [],
  truncated: false,
});

const stage = (runs: readonly HandlerRun[]): Section<StageRuns> => ({
  ok: true,
  value: { logGroup: 'group', runs, more: false },
});

const inbox = run('inbox', 'inbox-1', 1_700, 400);
const sources = [run('leadSources', 'source-1', 8_000, 300), run('leadSources', 'source-2', 8_100, 500)];

const runs: RequestRuns = {
  requestID,
  deployment: 'production-cdk',
  region: 'eu-north-1',
  from: iso(-120_000),
  to: iso(120_000),
  readAt: iso(60_000),
  stages: { inbox: stage([inbox]), leadSources: stage(sources), leads: { ok: false, error: 'throttled' } },
};

const entry: RequestView = {
  requestID: requestID as RequestView['requestID'],
  receivedAt: iso(0),
  updatedAt: iso(52_300),
  inboxStatus: 'processed',
  attachments: 2,
  sourcesPending: 0,
  sourcesProcessed: 2,
  sourcesRejected: 0,
  sourcesFailed: 0,
  sourcesLeads: 12,
  leadsPending: 0,
  leadsProcessed: 12,
  leadsRejected: 0,
  leadsFailed: 0,
  sourcesInQueue: 0,
  leadsInQueue: 0,
  state: 'done',
};

describe('the details of a request', () => {
  const details = requestDetailsOf(entry, runs);

  test('keep the stages that the source read, and name the stages that it could not read', () => {
    expect(details.loaded).toEqual([
      { stage: 'inbox', runs: [inbox] },
      { stage: 'leadSources', runs: sources },
    ]);
    expect(details.missing).toEqual(['leads']);
  });

  test('add up the runs of the stages that the source read', () => {
    expect(details.tally).toEqual({ runs: 3, computeMs: 1_200, lambda: runsPrice([inbox, ...sources]) });
  });

  test('take the cost facts from the entry that the server read', () => {
    expect(details.cost).toEqual(
      requestCostOf({ requestID, receivedAt: iso(0), attachments: 2 }, [
        { stage: 'inbox', runs: [inbox] },
        { stage: 'leadSources', runs: sources },
      ])
    );
  });

  test('of a standalone source have no receive time in the cost facts', () => {
    const { receivedAt: _, attachments: __, ...standalone } = entry;

    expect(requestDetailsOf(standalone, runs).cost).toEqual(
      requestCostOf({ requestID }, [
        { stage: 'inbox', runs: [inbox] },
        { stage: 'leadSources', runs: sources },
      ])
    );
  });
});

describe('a tally of runs', () => {
  test('adds no time for a run without a REPORT line', () => {
    const running = run('leads', 'lead-1', 50_000);

    expect(tallyOf([inbox, running])).toEqual({ runs: 2, computeMs: 400, lambda: runsPrice([inbox]) });
  });

  test('of no runs is empty', () => {
    expect(tallyOf([])).toEqual({ runs: 0, computeMs: 0, lambda: runsPrice([]) });
  });
});

describe('a change after the read', () => {
  const details = requestDetailsOf(entry, runs);

  test('is a newer change of the live entry than of the entry that the server read', () => {
    expect(changedAfterRead(details, { ...entry, updatedAt: iso(52_301) })).toBe(true);
    expect(changedAfterRead(details, entry)).toBe(false);
  });

  test('is not known when the entry left the live feed', () => {
    expect(changedAfterRead(details, undefined)).toBe(false);
  });
});
