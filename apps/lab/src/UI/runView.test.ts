import type { RequestProgress } from '@leads/shared/domain/request';
import { expect, test } from 'vitest';

import type { HandlerRun } from '#Core/Observation/Domain/runs';

import { runEndOf, runStateOf, stepsOf, timelineOf } from './runView';

const runOf = (runID: string, stage: HandlerRun['stage'], startedAt: string, endedAt?: string): HandlerRun => ({
  stage,
  runID,
  logStream: 'stream',
  startedAt,
  ...(endedAt !== undefined && { endedAt }),
  outcome: endedAt === undefined ? 'running' : 'ended',
  errors: 0,
  warnings: 0,
  otherRequests: 0,
  logBytes: 0,
  lines: [],
  truncated: false,
});

test.each<[RequestProgress, string[]]>([
  [{ inboxStatus: 'pending' }, ['email received']],
  [{ attachments: 3 }, ['3 attachments']],
  [{ attachments: 0 }, ['0 attachments']],
  [{ sourcesPending: 1 }, ['source started']],
  [{ sourcesLeads: 15 }, ['15 leads found']],
  [{ sourcesPending: -1, sourcesProcessed: 1 }, ['source processed']],
  [{ sourcesPending: -1, sourcesFailed: 1, leadsFailed: 4 }, ['source failed', '4 leads failed']],
  [{ leadsPending: 1 }, ['1 lead taken']],
  [{ leadsPending: -10, leadsProcessed: 9, leadsFailed: 1 }, ['9 leads stored', '1 lead failed']],
  [{ inboxStatus: 'rejected' }, ['email rejected']],
])('the progress write %j is the steps %j', (change, texts) => {
  expect(stepsOf(change).map(({ text }) => text)).toEqual(texts);
});

test('an ended run with logged errors is a warning, not a failure', () => {
  const run = runOf('a', 'inbox', '2026-10-13T17:15:34.000Z', '2026-10-13T17:15:35.000Z');

  expect(runStateOf(run)).toEqual(['ok', 'ended']);
  expect(runStateOf({ ...run, errors: 1 })).toEqual(['warning', 'ended with errors']);
  expect(runStateOf({ ...run, outcome: 'timeout' })).toEqual(['critical', 'timed out']);
});

test('a run without an end lasts until now', () => {
  const run = runOf('a', 'leads', '2026-10-13T17:15:34.000Z');

  expect(runEndOf(run, Date.parse('2026-10-13T17:15:40.000Z'))).toBe(Date.parse('2026-10-13T17:15:40.000Z'));
});

test('the timeline starts when the email came in and puts overlapping runs in different rows', () => {
  const timeline = timelineOf(
    [
      { stage: 'inbox', runs: [runOf('i', 'inbox', '2026-10-13T17:15:01.000Z', '2026-10-13T17:15:03.000Z')] },
      {
        stage: 'leadSources',
        runs: [
          runOf('s2', 'leadSources', '2026-10-13T17:15:04.000Z', '2026-10-13T17:15:06.000Z'),
          runOf('s1', 'leadSources', '2026-10-13T17:15:03.000Z', '2026-10-13T17:15:05.000Z'),
          runOf('s3', 'leadSources', '2026-10-13T17:15:05.000Z', '2026-10-13T17:15:06.000Z'),
        ],
      },
      { stage: 'leads', runs: [] },
    ],
    '2026-10-13T17:15:00.000Z',
    Date.parse('2026-10-13T18:00:00.000Z')
  );

  expect(timeline?.start).toBe(Date.parse('2026-10-13T17:15:00.000Z'));
  expect(timeline?.end).toBe(Date.parse('2026-10-13T17:15:06.000Z'));
  expect(timeline?.lanes[0]?.bars[0]).toMatchObject({ left: 1 / 6, width: 2 / 6, row: 0 });
  expect(timeline?.lanes[1]?.bars.map(({ run, row }) => [run.runID, row])).toEqual([
    ['s1', 0],
    ['s2', 1],
    ['s3', 0],
  ]);
  expect(timeline?.lanes[1]?.rows).toBe(2);
  expect(timeline?.lanes[2]).toEqual({ stage: 'leads', rows: 1, bars: [] });
});

test('no timeline without runs', () => {
  expect(timelineOf([{ stage: 'inbox', runs: [] }], undefined, 0)).toBeUndefined();
});
