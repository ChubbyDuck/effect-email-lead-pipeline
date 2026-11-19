import type { RequestProgress } from '@leads/shared/domain/request';
import type { StageName } from '@leads/shared/domain/stages';
import { describe, expect, test } from 'vitest';

import { waitingAt } from '#Core/Simulation/Domain/lane';
import { sliceDefaults } from '#Core/Simulation/Domain/sources';

import { comparisonOf, shapeOf, loadedOf, statsOf, verdictOf, type ComparisonNote } from './comparison';
import type { RequestView } from './requests';
import type { HandlerRun, RequestRuns, RunLine, StageRuns } from './runs';
import type { Section } from './snapshot';

const requestID = 'ntls5k1165jcg1a8otpg8kcqrsva6q18lk7ond81';
const otherID = 'aj8bllniv9qsu5f5gq1jg5v1fkk2grjeqa4u1381';
const receivedAt = Date.parse('2026-10-16T11:49:21.796Z');
const iso = (ms: number) => new Date(receivedAt + ms).toISOString();

const progress = (ms: number, change: RequestProgress, id = requestID): RunLine => ({
  time: iso(ms),
  level: 'info',
  message: `Progress of request ${id}: ${JSON.stringify(change)}`,
  progress: { requestID: id, change },
});

const size = (ms: number, kind: 'email' | 'source', key: string, bytes: number): RunLine => ({
  time: iso(ms),
  level: 'info',
  message: `File size of request ${requestID}`,
  fileSize: { requestID, size: { kind, key, bytes } },
});

/** A run that starts its handler code at `startMs` on the clock, after `initMs` of INIT. */
const run = (
  stage: StageName,
  runID: string,
  startMs: number,
  durationMs: number,
  lines: readonly RunLine[],
  extra: Partial<HandlerRun> = {}
): HandlerRun => ({
  stage,
  runID,
  logStream: 'stream',
  startedAt: iso(startMs),
  endedAt: iso(startMs + durationMs),
  outcome: 'ended',
  durationMs,
  billedMs: Math.ceil(durationMs),
  memoryMb: 128,
  maxMemoryMb: 100,
  errors: 0,
  warnings: 0,
  otherRequests: 0,
  logBytes: 800,
  lines,
  truncated: false,
  ...extra,
});

const inboxRun = run(
  'inbox',
  'inbox-1',
  1_700,
  4_800,
  [
    size(3_600, 'email', requestID, 98_525),
    progress(5_800, { attachments: 3 }),
    progress(6_200, { inboxStatus: 'processed' }),
  ],
  { initMs: 470 }
);

const sourceRun = (index: number, leads: number, bytes: number) =>
  run('leadSources', `source-${index}`, 8_000 + index * 30, 360, [
    progress(8_000 + index * 30, { sourcesPending: 1 }),
    size(8_090 + index * 30, 'source', `${requestID}/0${index}`, bytes),
    progress(8_120 + index * 30, { sourcesLeads: leads }),
    progress(8_170 + index * 30, { sourcesPending: -1, sourcesProcessed: 1 }),
  ]);

const leadRun = (runID: string, startMs: number, leads: number, others = 0) =>
  run(
    'leads',
    runID,
    startMs,
    3_100,
    [
      progress(startMs + 20, { leadsPending: leads }),
      ...(others > 0 ? [progress(startMs + 25, { leadsPending: others }, otherID)] : []),
      progress(startMs + 1_700, { leadsPending: -leads, leadsProcessed: leads }),
    ],
    { initMs: 580, otherRequests: others > 0 ? 1 : 0 }
  );

const stage = (runs: readonly HandlerRun[], more = false): Section<StageRuns> => ({
  ok: true,
  value: { logGroup: 'group', runs, more },
});

const requestRuns = (stages: Partial<Record<StageName, Section<StageRuns>>> = {}): RequestRuns => ({
  requestID,
  deployment: 'production-cdk',
  region: 'eu-north-1',
  from: iso(-120_000),
  to: iso(120_000),
  readAt: iso(60_000),
  stages: {
    inbox: stage([inboxRun]),
    leadSources: stage([sourceRun(1, 5, 20_976), sourceRun(2, 5, 19_615), sourceRun(3, 5, 21_000)]),
    leads: stage([leadRun('lead-1', 50_000, 8), leadRun('lead-2', 50_030, 7)]),
    ...stages,
  },
});

const entry: RequestView = {
  requestID: requestID as RequestView['requestID'],
  receivedAt: iso(0),
  updatedAt: iso(52_300),
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
  sourcesInQueue: 0,
  leadsInQueue: 0,
  state: 'done',
};

const input = { ...sliceDefaults, in_c: 50, src_c: 200 };
const texts = (notes: readonly ComparisonNote[], kind: ComparisonNote['kind']) =>
  notes.filter((note) => note.kind === kind).map((note) => note.text);

describe('the shape of a request', () => {
  test('is one email with its attachments, the mean leads of a source, and the mean bytes of a row', () => {
    const { shape, leadsBySource, measuredRow } = shapeOf(entry, loadedOf(requestRuns()), input);

    expect(shape).toEqual({ E: 1, S: 3, L: 5, row_b: Math.round((20_976 / 5 + 19_615 / 5 + 21_000 / 5) / 3) });
    expect(leadsBySource).toEqual([5, 5, 5]);
    expect(measuredRow).toBe(true);
  });

  test('counts a source that a retry read again once', () => {
    const retry = { ...sourceRun(1, 5, 20_976), runID: 'source-1-retry', startedAt: iso(9_000) };
    const runs = requestRuns({ leadSources: stage([sourceRun(1, 5, 20_976), retry, sourceRun(2, 7, 19_615)]) });

    expect(shapeOf(entry, loadedOf(runs), input).leadsBySource).toEqual([5, 7]);
  });

  test('keeps the leads of a source when a retry stopped before its count', () => {
    const retry = run('leadSources', 'source-1-retry', 9_000, 100, [size(9_050, 'source', `${requestID}/01`, 20_976)], {
      outcome: 'failed',
    });
    const runs = requestRuns({ leadSources: stage([sourceRun(1, 5, 20_976), retry, sourceRun(2, 7, 19_615)]) });

    expect(shapeOf(entry, loadedOf(runs), input).leadsBySource).toEqual([5, 7]);
  });

  test('keeps row_b and takes L from the ledger when no source run loaded', () => {
    const runs = requestRuns({ leadSources: { ok: false, error: 'throttled' } });
    const { shape, measuredRow } = shapeOf(entry, loadedOf(runs), input);

    expect(shape).toMatchObject({ S: 3, L: 5, row_b: input.row_b });
    expect(measuredRow).toBe(false);
  });
});

describe('the real runs on the clock', () => {
  const comparison = comparisonOf({ entry, runs: requestRuns() }, input);

  test('start each wave with its INIT before the START line, from the time S3 stored the email', () => {
    const [wave] = comparison.lanes.inbox.pool.waves;

    expect(comparison.origin).toBe(receivedAt);
    expect(wave).toEqual({ start: 1_700 - 470, end: 1_700 + 4_800, count: 1, init: 470 });
    expect(comparison.lanes.inbox.pool.environments).toBe(1);
  });

  test('cut a run into ranges between its lines, after its INIT', () => {
    const pieces = comparison.lanes.inbox.rows[0]!.pieces.map(({ symbol, start, end }) => [symbol, start, end]);

    expect(pieces).toEqual([
      ['INIT', 0, 470],
      ['read', 470, 470 + 1_900],
      ['parse', 470 + 1_900, 470 + 4_100],
      ['puts', 470 + 4_100, 470 + 4_500],
      ['delete', 470 + 4_500, 470 + 4_800],
    ]);
    expect(comparison.lanes.inbox.rows[0]!.pieces[3]).toMatchObject({ amount: 3, unit: 'source' });
  });

  test('join a range to the next when the run has no line for it', () => {
    const noSize = { ...inboxRun, lines: inboxRun.lines.filter((line) => line.fileSize === undefined) };
    const runs = requestRuns({ inbox: stage([noSize]) });
    const symbols = comparisonOf({ entry, runs }, input).lanes.inbox.rows[0]!.pieces.map(({ symbol }) => symbol);

    expect(symbols).toEqual(['INIT', 'parse', 'puts', 'delete']);
  });

  test('give a lead run only the leads of this request as its batch', () => {
    const runs = requestRuns({ leads: stage([leadRun('lead-1', 50_000, 8, 12)]) });
    const shared = comparisonOf({ entry, runs }, input);

    expect(shared.lanes.leads.pool.waves[0]?.batch).toBe(8);
    expect(shared.lanes.leads.pool.taken).toEqual([8]);
    expect(texts(shared.notes, 'limit')).toContain(
      '1 lead run also took the leads of other requests. Its bar shows the whole run. The real cost counts only the share of this request.'
    );
  });

  test('release the sources in put waves of in_c over the time of the puts', () => {
    expect(comparisonOf({ entry, runs: requestRuns() }, { ...input, in_c: 1 }).lanes.sources.releases).toEqual([
      { at: 5_800 + 400 / 3, amount: 1 },
      { at: 5_800 + 800 / 3, amount: 1 },
      { at: 6_200, amount: 1 },
    ]);
    expect(comparison.lanes.sources.releases).toEqual([{ at: 6_200, amount: 3 }]);
  });

  test('release the leads of a source at the end of its sends', () => {
    expect(comparison.lanes.leads.releases.map(({ amount }) => amount)).toEqual([5, 5, 5]);
    expect(comparison.lanes.leads.releases[0]?.at).toBe(8_170 + 30);
  });

  test('never wait a negative count, also when a run takes a message before the estimate releases it', () => {
    const early = { ...sourceRun(1, 5, 20_976), startedAt: iso(3_000) };
    const runs = requestRuns({ leadSources: stage([early, sourceRun(2, 5, 19_615), sourceRun(3, 5, 21_000)]) });
    const shifted = comparisonOf({ entry, runs }, input);

    expect(waitingAt(shifted.lanes.sources, 4_000)).toBe(0);
    expect(waitingAt(shifted.lanes.sources, 7_000)).toBe(2);
    expect(waitingAt(shifted.lanes.sources, 9_000)).toBe(0);
    expect(waitingAt(comparison.lanes.leads, 9_000)).toBe(15);
    expect(waitingAt(comparison.lanes.leads, 52_000)).toBe(0);
  });

  test('hold the email in its queue until its first inbox run takes it, also after a retry', () => {
    const retry = { ...inboxRun, runID: 'inbox-2', startedAt: iso(20_000) };
    const retried = comparisonOf({ entry, runs: requestRuns({ inbox: stage([inboxRun, retry]) }) }, input);

    expect(waitingAt(comparison.lanes.inbox, 0)).toBe(1);
    expect(waitingAt(comparison.lanes.inbox, 1_700 - 470)).toBe(0);
    expect(waitingAt(retried.lanes.inbox, 21_000)).toBe(0);
  });

  test('leave the email queue empty when no inbox run loaded', () => {
    const runs = requestRuns({ inbox: { ok: false, error: 'throttled' } });

    expect(waitingAt(comparisonOf({ entry, runs }, input).lanes.inbox, 0)).toBe(0);
  });

  test('fill the queues with the sources of the request and the leads that their runs counted', () => {
    const runs = requestRuns({ leadSources: stage([sourceRun(1, 4, 1_000), sourceRun(2, 7, 1_000)]) });
    const { lanes } = comparisonOf({ entry, runs }, input);

    expect([lanes.inbox.total, lanes.sources.total, lanes.leads.total]).toEqual([1, 3, 11]);
    expect([lanes.inbox.cap, lanes.sources.cap, lanes.leads.cap]).toEqual([input.E_q_c, input.S_q_c, input.L_q_c]);
  });
});

describe('the notes of a comparison', () => {
  test('name a stage that did not load and a stage with more runs than one read takes', () => {
    const runs = requestRuns({ inbox: { ok: false, error: 'throttled' }, leads: stage([], true) });
    const notes = comparisonOf({ entry, runs }, input).notes;

    expect(texts(notes, 'error')).toEqual(['The runs of the inbox stage did not load: throttled']);
    expect(texts(notes, 'limit')[0]).toContain('The logs hold more of the leads stage than one read takes');
  });

  test('say that the model gives every source the mean when the sources differ', () => {
    const runs = requestRuns({ leadSources: stage([sourceRun(1, 4, 1_000), sourceRun(2, 6, 1_000)]) });

    expect(texts(comparisonOf({ entry, runs }, input).notes, 'estimate')).toContain(
      'The sources have 4, 6 leads. The model gives every source the mean, L = 5.'
    );
  });

  test('say that a run without a REPORT line ends at the read', () => {
    const { durationMs: _duration, endedAt: _ended, ...open } = leadRun('lead-1', 50_000, 8);
    const runs = requestRuns({ leads: stage([{ ...open, outcome: 'running' }]) });
    const comparison = comparisonOf({ entry, runs }, input);

    expect(comparison.lanes.leads.pool.end).toBe(60_000);
    expect(texts(comparison.notes, 'limit')).toContain(
      '1 run has no REPORT line yet. Its bar ends at the time of the read, and the real cost leaves its time out.'
    );
  });
});

test('the stats of a stage read a model run and a real run the same way', () => {
  const comparison = comparisonOf({ entry, runs: requestRuns() }, input);

  expect(statsOf(comparison.lanes.leads.pool)).toEqual({
    handlers: 2,
    coldStarts: 2,
    firstStart: 50_000 - 580,
    lastEnd: 50_030 + 3_100,
    meanDuration: 3_100,
  });
  expect(statsOf({ waves: [], started: [], taken: [], environments: 0, end: 0 })).toEqual({
    handlers: 0,
    coldStarts: 0,
  });
});

test('the swarm of the real runs counts their output in the range that releases it', () => {
  const comparison = comparisonOf({ entry, runs: requestRuns() }, input);
  const sources = comparison.lanes.sources.swarm;

  expect(sources).toMatchObject({ start: 8_030, end: 8_090 + 360, handlers: 3, output: 15 });
  expect(sources.peakCalls.value).toBe(2);
  expect(comparison.lanes.leads.swarm.peakRunning).toEqual({ at: 50_030 - 580, value: 2 });
});

describe('verdictOf', () => {
  test('reads a lower real value as better and a higher one as worse', () => {
    expect(verdictOf(937, 959)).toBe('better');
    expect(verdictOf(5_858, 3_113)).toBe('worse');
  });

  test('reads no cold starts against one as better', () => {
    expect(verdictOf(0, 1)).toBe('better');
  });

  test('reads equal values as the same, also at zero', () => {
    expect(verdictOf(1, 1)).toBe('same');
    expect(verdictOf(0, 0)).toBe('same');
  });

  test('reads the rounding noise of a sum of prices as the same', () => {
    expect(verdictOf(0.1 + 0.2, 0.3)).toBe('same');
  });

  test('still sees a small difference of very small prices', () => {
    expect(verdictOf(0.000245, 0.000256)).toBe('better');
  });

  test('has no verdict without one of the values', () => {
    expect(verdictOf(undefined, 959)).toBeUndefined();
    expect(verdictOf(937, undefined)).toBeUndefined();
  });
});
