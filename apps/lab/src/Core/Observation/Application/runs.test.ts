import { describe, expect, test } from 'vitest';

import type { RawLogEvent } from '#Core/Observation/Domain/runs';
import { logGroupOf, makeLogSearch } from '#Core/Observation/Ports/testing/logSearch';

import { readRuns, runLimit, runsMatching } from './runs';

const requestID = 'aj8bllniv9qsu5f5gq1jg5v1fkk2grjeqa4u1381';
const at = Date.parse('2026-10-13T17:15:34.000Z');
const from = new Date(at - 60_000);
const to = new Date(at + 600_000);

const runID = (index: number) => `20b3ae96-eb9e-5c4b-ab2f-${String(index).padStart(12, '0')}`;

const line = (offsetMs: number, id: string, text: string): RawLogEvent => ({
  timestamp: at + offsetMs,
  message: `${new Date(at + offsetMs).toISOString()}\t${id}\tINFO\t[17:15:34.120] INFO (#3): ${text}\n`,
  logStream: 'stream',
});

/** A run that logs the request between a line before and a line after it. */
const runOf = (id: string, offsetMs = 0): RawLogEvent[] => [
  { timestamp: at + offsetMs, message: `START RequestId: ${id} Version: $LATEST\n`, logStream: 'stream' },
  line(offsetMs + 1, id, 'Read the file'),
  line(offsetMs + 2, id, `Progress of request ${requestID}: {"inboxStatus":"processed"}`),
  {
    timestamp: at + offsetMs + 3,
    message: `REPORT RequestId: ${id}\tDuration: 3.00 ms\tBilled Duration: 3 ms\tMemory Size: 128 MB\tMax Memory Used: 90 MB\t\n`,
    logStream: 'stream',
  },
];

const search = { stage: 'inbox', logGroup: logGroupOf('inbox'), terms: [requestID], requestID, from, to } as const;

describe('the runs that match a search', () => {
  test('have all their lines, also the lines without the term', async () => {
    const { logs } = makeLogSearch({ events: { inbox: [...runOf(runID(1)), ...runOf(runID(2), 1_000)] } });

    const { runs, more } = await runsMatching(logs, search);

    expect(runs.map(({ runID, outcome, lines }) => ({ runID, outcome, lines: lines.length }))).toEqual([
      { runID: runID(1), outcome: 'ended', lines: 4 },
      { runID: runID(2), outcome: 'ended', lines: 4 },
    ]);
    expect(more).toBe(false);
  });

  test('come from a search for the terms, then a search for the IDs of their runs', async () => {
    const { logs, searches } = makeLogSearch({ events: { inbox: [...runOf(runID(2), 1_000), ...runOf(runID(1))] } });

    await runsMatching(logs, search);

    expect(searches).toEqual([
      { logGroup: logGroupOf('inbox'), terms: [requestID], from, to },
      { logGroup: logGroupOf('inbox'), terms: [runID(1), runID(2)], from, to },
    ]);
  });

  test('need no second search when no line matches', async () => {
    const { logs, searches } = makeLogSearch({ events: { inbox: runOf(runID(1)) } });

    const { runs } = await runsMatching(logs, { ...search, terms: ['no such text'] });

    expect(runs).toEqual([]);
    expect(searches).toHaveLength(1);
  });

  test(`are at most ${runLimit}, the oldest, and say that the logs have more`, async () => {
    const events = Array.from({ length: runLimit + 1 }, (_, index) => runOf(runID(index), index * 10)).flat();
    const { logs } = makeLogSearch({ events: { inbox: events } });

    const { runs, more } = await runsMatching(logs, search);

    expect(runs).toHaveLength(runLimit);
    expect(runs.at(-1)?.runID).toBe(runID(runLimit - 1));
    expect(more).toBe(true);
  });

  test('say that the logs have more when a search gives only a part of its lines', async () => {
    const { logs } = makeLogSearch({ events: { inbox: runOf(runID(1)) }, limit: 2 });

    expect((await runsMatching(logs, search)).more).toBe(true);
  });
});

describe('the runs of a request', () => {
  test('come from each stage, and a stage that the logs cannot give holds its error', async () => {
    const { logs } = makeLogSearch({ events: { inbox: runOf(runID(1)) }, failing: ['leads'] });

    const read = await readRuns(logs, { requestID, from, to }, at + 700_000);

    expect(read).toMatchObject({
      requestID,
      deployment: 'production-cdk',
      region: 'eu-north-1',
      from: from.toISOString(),
      to: to.toISOString(),
      readAt: new Date(at + 700_000).toISOString(),
      stages: {
        inbox: { ok: true, value: { logGroup: logGroupOf('inbox'), runs: [{ runID: runID(1) }], more: false } },
        leadSources: { ok: true, value: { logGroup: logGroupOf('leadSources'), runs: [], more: false } },
        leads: { ok: false, error: 'Error: throttled' },
      },
    });
  });
});
