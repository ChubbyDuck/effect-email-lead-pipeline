import type { RequestProgress } from '@leads/shared/domain/request';
import type { StageName } from '@leads/shared/domain/stages';
import { describe, expect, it } from 'vitest';

import { loadedOf } from '#Core/Observation/Domain/comparison';
import { requestCostOf } from '#Core/Observation/Domain/requestCost';
import type { RequestView } from '#Core/Observation/Domain/requests';
import type { HandlerRun, RequestRuns, RunLine, StageRuns } from '#Core/Observation/Domain/runs';
import type { Section } from '#Core/Observation/Domain/snapshot';
import { sliceDefaults } from '#Core/Simulation/Domain/sources';

import { handler } from './handler';

const requestID = 'ntls5k1165jcg1a8otpg8kcqrsva6q18lk7ond81';
const receivedAt = Date.parse('2026-10-16T11:49:21.796Z');
const iso = (ms: number) => new Date(receivedAt + ms).toISOString();

const progress = (ms: number, change: RequestProgress): RunLine => ({
  time: iso(ms),
  level: 'info',
  message: `Progress of request ${requestID}: ${JSON.stringify(change)}`,
  progress: { requestID, change },
});

const size = (ms: number, key: string, bytes: number): RunLine => ({
  time: iso(ms),
  level: 'info',
  message: `File size of request ${requestID}`,
  fileSize: { requestID, size: { kind: 'source', key, bytes } },
});

const run = (stage: StageName, runID: string, startMs: number, lines: readonly RunLine[]): HandlerRun => ({
  stage,
  runID,
  logStream: 'stream',
  startedAt: iso(startMs),
  endedAt: iso(startMs + 400),
  outcome: 'ended',
  durationMs: 400,
  billedMs: 400,
  memoryMb: 128,
  maxMemoryMb: 100,
  errors: 0,
  warnings: 0,
  otherRequests: 0,
  logBytes: 800,
  lines,
  truncated: false,
});

const sourceRun = (index: number, leads: number, bytes: number) =>
  run('leadSources', `source-${index}`, 8_000 + index * 30, [
    size(8_090 + index * 30, `${requestID}/0${index}`, bytes),
    progress(8_120 + index * 30, { sourcesLeads: leads }),
  ]);

const stage = (runs: readonly HandlerRun[]): Section<StageRuns> => ({
  ok: true,
  value: { logGroup: 'group', runs, more: false },
});

const runs: RequestRuns = {
  requestID,
  deployment: 'production-cdk',
  region: 'eu-north-1',
  from: iso(-120_000),
  to: iso(120_000),
  readAt: iso(60_000),
  stages: {
    inbox: stage([run('inbox', 'inbox-1', 1_700, [progress(5_800, { attachments: 2 })])]),
    leadSources: stage([sourceRun(1, 4, 4_000), sourceRun(2, 8, 12_000)]),
    leads: stage([run('leads', 'lead-1', 50_000, [progress(51_700, { leadsProcessed: 12 })])]),
  },
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

const knobs = { ...sliceDefaults, in_c: 50, src_c: 200, delay_src: 3, src_storage_read_t: 900 };

describe('CompareRequest', () => {
  it('sets the four keys of the shape from the request', () => {
    const result = handler({ loaded: { entry, runs }, knobs });

    expect(result.knobs).toMatchObject({ E: 1, S: 2, L: 6, row_b: 1_250 });
    expect(result.comparison.shape).toEqual({ E: 1, S: 2, L: 6, row_b: 1_250 });
  });

  it('keeps the timing knobs as the command gave them', () => {
    const { knobs: merged } = handler({ loaded: { entry, runs }, knobs });

    const { E: _E, S: _S, L: _L, row_b: _row, ...timing } = knobs;
    expect(merged).toMatchObject(timing);
  });

  it('gives the request cost of the loaded runs', () => {
    const { cost } = handler({ loaded: { entry, runs }, knobs });

    expect(cost).toEqual(requestCostOf({ requestID, receivedAt: iso(0), attachments: 2 }, loadedOf(runs)));
    expect(cost.cost).toBeGreaterThan(0);
  });
});
