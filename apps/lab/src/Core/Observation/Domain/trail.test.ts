import type { RequestProgress } from '@leads/shared/domain/request';
import type { StageName } from '@leads/shared/domain/stages';
import { describe, expect, test } from 'vitest';

import { type HandlerRun, type RawLogEvent, toRuns } from './runs';
import { emailBytesOf, filesOf, runTrailOf } from './trail';

const requestID = 'aj8bllniv9qsu5f5gq1jg5v1fkk2grjeqa4u1381';
const otherID = 'bk9cmmojw0rtv6g6hr2kh6w2gll3hsfkrb5v2492';
const runID = '20b3ae96-eb9e-5c4b-ab2f-cdd1e969bbe4';
const retry = '442edb0c-ad2e-5584-868a-b84bafd22c2a';
const at = Date.parse('2026-10-13T17:15:34.000Z');
const iso = (offsetMs: number) => new Date(at + offsetMs).toISOString();

const event = (offsetMs: number, message: string): RawLogEvent => ({
  timestamp: at + offsetMs,
  message,
  logStream: 's',
});

const codeLine = (offsetMs: number, text: string, id = runID) =>
  `${iso(offsetMs)}\t${id}\tINFO\t[17:15:34.120] INFO (#3): ${text}\n`;

const progressLine = (offsetMs: number, change: RequestProgress, request = requestID, id = runID) =>
  event(offsetMs, codeLine(offsetMs, `Progress of request ${request}: ${JSON.stringify(change)}`, id));

const sizeLine = (offsetMs: number, size: object, request = requestID, id = runID) =>
  event(offsetMs, codeLine(offsetMs, `File size of request ${request}: ${JSON.stringify(size)}`, id));

const start = (offsetMs: number, id = runID) => event(offsetMs, `START RequestId: ${id} Version: $LATEST\n`);
const end = (offsetMs: number, id = runID) => [
  event(offsetMs, `END RequestId: ${id}\n`),
  event(offsetMs, `REPORT RequestId: ${id}\tDuration: 5.00 ms\tBilled Duration: 5 ms\tMemory Size: 128 MB\t\n`),
];
const failed = (offsetMs: number, id = runID) =>
  event(offsetMs, `REPORT RequestId: ${id}\tDuration: 5.00 ms\tStatus: error\tError Type: Runtime.ExitError\n`);

const runOf = (stage: StageName, events: readonly RawLogEvent[]): HandlerRun => toRuns(stage, requestID, events)[0]!;

const email = { kind: 'email', key: `received/${requestID}`, bytes: 300_000 } as const;
const source = { kind: 'source', key: `13-10-2026/17-10/${requestID}/01-leads`, bytes: 12_345 } as const;

describe('the trail of one run', () => {
  test('keeps the changes and the reads of the request, oldest first, with their times', () => {
    const trail = runTrailOf(
      runOf('leadSources', [
        progressLine(1, { sourcesPending: 1 }),
        sizeLine(2, source),
        sizeLine(3, { ...source, key: 'other' }, otherID),
        progressLine(4, { sourcesLeads: 25 }),
        progressLine(5, { sourcesPending: -1, sourcesProcessed: 1 }),
      ]),
      requestID
    );

    expect(trail.changes).toEqual([
      { at: at + 1, change: { sourcesPending: 1 } },
      { at: at + 4, change: { sourcesLeads: 25 } },
      { at: at + 5, change: { sourcesPending: -1, sourcesProcessed: 1 } },
    ]);
    expect(trail.reads).toEqual([{ at: at + 2, size: source }]);
    expect(trail.leadsFound).toBe(25);
    expect(trail).not.toHaveProperty('attachments');
  });

  test('has the attachments that an inbox run counted, also a count of 0', () => {
    const counted = (count: number) => runOf('inbox', [progressLine(1, { attachments: count })]);

    expect(runTrailOf(counted(3), requestID).attachments).toBe(3);
    expect(runTrailOf(counted(0), requestID).attachments).toBe(0);
  });

  test('counts only the leads that a lead run took, not the leads that it ended', () => {
    const trail = runTrailOf(
      runOf('leads', [
        progressLine(1, { leadsPending: 10 }),
        progressLine(2, { leadsPending: -10, leadsProcessed: 9, leadsFailed: 1 }),
      ]),
      requestID
    );

    expect(trail.leadsTaken).toBe(10);
    expect(trail.share).toBe(1);
  });

  test('pays its own leads of a lead run that other requests share', () => {
    const run = runOf('leads', [
      progressLine(1, { leadsPending: 3 }),
      progressLine(2, { leadsPending: 7 }, otherID),
      progressLine(3, { leadsPending: -3, leadsProcessed: 3 }),
      progressLine(4, { leadsPending: -7, leadsProcessed: 7 }, otherID),
    ]);

    expect(runTrailOf(run, requestID).share).toBeCloseTo(0.3, 10);
    expect(runTrailOf(run, otherID).share).toBeCloseTo(0.7, 10);
  });

  test('pays the whole run of a stage that works on one request', () => {
    expect(runTrailOf(runOf('inbox', [progressLine(1, { attachments: 2 })]), requestID).share).toBe(1);
  });
});

describe('the files of a request', () => {
  test('keep one file for each key, because a retry reads the same file again', () => {
    const runs = toRuns('inbox', requestID, [
      start(0),
      sizeLine(5, email),
      failed(10),
      start(9000, retry),
      sizeLine(9005, email, requestID, retry),
      ...end(9500, retry),
    ]);

    expect(filesOf(runs, requestID)).toEqual([{ ...email, readAt: iso(5), endedAt: iso(9500), leads: 0 }]);
  });

  test('keep the end of an earlier run that ended, when a later run that read the file has no end yet', () => {
    const runs = toRuns('inbox', requestID, [
      start(0),
      sizeLine(5, email),
      ...end(500),
      start(9000, retry),
      sizeLine(9005, email, requestID, retry),
    ]);

    expect(filesOf(runs, requestID)[0]?.endedAt).toBe(iso(500));
  });

  test('keep the leads of a source when a retry stopped before its count', () => {
    const runs = toRuns('leadSources', requestID, [
      start(0),
      sizeLine(5, source),
      progressLine(6, { sourcesLeads: 25 }),
      failed(10),
      start(9000, retry),
      sizeLine(9005, source, requestID, retry),
      failed(9010, retry),
    ]);

    expect(filesOf(runs, requestID)).toEqual([{ ...source, readAt: iso(5), leads: 25 }]);
  });

  test('keep the files of the request only', () => {
    const runs = toRuns('leadSources', requestID, [
      sizeLine(5, source),
      sizeLine(6, { ...source, key: 'other' }, otherID),
    ]);

    expect(filesOf(runs, requestID)).toEqual([{ ...source, readAt: iso(5), leads: 0 }]);
  });
});

test('the bytes of the emails in the raw lines of many requests count each email once', () => {
  const raw = (size: object, id: string) => codeLine(0, `File size of request r1: ${JSON.stringify(size)}`, id);

  expect(
    emailBytesOf([
      raw({ kind: 'email', key: 'received/a', bytes: 300_000 }, runID),
      // A retry reads the same email again.
      raw({ kind: 'email', key: 'received/a', bytes: 300_000 }, retry),
      raw({ kind: 'email', key: 'received/b', bytes: 1000 }, retry),
      // A source is not an email.
      raw({ kind: 'source', key: 'sources/c', bytes: 5000 }, retry),
    ])
  ).toEqual([300_000, 1000]);
});
