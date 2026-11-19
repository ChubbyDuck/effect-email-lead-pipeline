import { describe, expect, test } from 'vitest';

import { longestSearchMs, parseLine, type RawLogEvent, runIDOf, runLineLimit, searchWindowOf, toRuns } from './runs';

const requestID = 'aj8bllniv9qsu5f5gq1jg5v1fkk2grjeqa4u1381';
const runID = '20b3ae96-eb9e-5c4b-ab2f-cdd1e969bbe4';
const at = Date.parse('2026-10-13T17:15:34.000Z');

const event = (offsetMs: number, message: string, logStream = '2026/10/13/[$LATEST]f865b09b5180'): RawLogEvent => ({
  timestamp: at + offsetMs,
  message,
  logStream,
});

const codeLine = (offsetMs: number, text: string, id = runID, level = 'INFO') =>
  `${new Date(at + offsetMs).toISOString()}\t${id}\t${level}\t${text}\n`;

const progressLine = (offsetMs: number, request: string, change: object, id = runID) =>
  codeLine(offsetMs, `[17:15:34.120] INFO (#3): Progress of request ${request}: ${JSON.stringify(change)}`, id);

const fileSizeLine = (offsetMs: number, request: string, size: object, id = runID) =>
  codeLine(offsetMs, `[17:15:34.120] INFO (#3): File size of request ${request}: ${JSON.stringify(size)}`, id);

const report = (id: string, rest: string) =>
  `REPORT RequestId: ${id}\tDuration: 5084.66 ms\tBilled Duration: 5662 ms\tMemory Size: 128 MB\tMax Memory Used: 124 MB\t${rest}\n`;

describe('a line of a run', () => {
  test.each([
    [`START RequestId: ${runID} Version: $LATEST\n`, 'platform'],
    [`END RequestId: ${runID}\n`, 'platform'],
    [report(runID, 'Init Duration: 577.16 ms\t'), 'platform'],
    [codeLine(5, '[17:15:34.120] WARN (#20): Runtime settings are stale'), 'warn'],
    [codeLine(5, '[17:15:34.120] ERROR (#2): {\n  reason: "Sender is outside the whitelist"\n}'), 'error'],
    [codeLine(5, 'Invoke Error \t{}', runID, 'ERROR'), 'error'],
    [`2026-10-13T17:15:39.000Z ${runID} Task timed out after 60.00 seconds\n`, 'error'],
  ])('has the ID of its run in %j', (line, level) => {
    expect(parseLine(line)).toMatchObject({ runID, level });
  });

  test('has no run when the runtime writes it outside a run', () => {
    expect(
      runIDOf('INIT_START Runtime Version: nodejs:24.mainline.v79\tRuntime Version ARN: arn:aws:lambda:x\n')
    ).toBeUndefined();
  });

  test('has no run when the runtime writes it in the INIT phase, but keeps its level', () => {
    const line = parseLine('2026-10-13T17:15:34.000Z\tundefined\tERROR\tUncaught Exception \t{}\n');

    expect(line).toMatchObject({ level: 'error', message: 'Uncaught Exception \t{}' });
    expect(line.runID).toBeUndefined();
  });

  test('keeps the message of an Effect line without the prefix of Lambda and Effect', () => {
    expect(parseLine(codeLine(5, '[17:15:34.120] WARN (#20): Runtime settings are stale')).message).toBe(
      'Runtime settings are stale'
    );
  });
});

describe('the runs of a stage', () => {
  test('have the timings and the memory of their REPORT line', () => {
    const [run] = toRuns('inbox', requestID, [
      event(5084, report(runID, 'Init Duration: 577.16 ms\t')),
      event(0, `START RequestId: ${runID} Version: $LATEST\n`),
      event(5084, `END RequestId: ${runID}\n`),
    ]);

    expect(run).toMatchObject({
      stage: 'inbox',
      runID,
      startedAt: '2026-10-13T17:15:34.000Z',
      endedAt: '2026-10-13T17:15:39.084Z',
      outcome: 'ended',
      durationMs: 5084.66,
      billedMs: 5662,
      initMs: 577.16,
      memoryMb: 128,
      maxMemoryMb: 124,
      logStream: '2026/10/13/[$LATEST]f865b09b5180',
    });
    expect(run!.lines.map(({ level }) => level)).toEqual(['platform', 'platform', 'platform']);
  });

  test('without a START line start at the end of the run minus its duration', () => {
    const [run] = toRuns('inbox', requestID, [event(5084, report(runID, ''))]);

    expect(run?.startedAt).toBe(new Date(at + 5084 - 5084.66).toISOString());
    expect(run?.initMs).toBeUndefined();
  });

  test('without an end still run', () => {
    const [run] = toRuns('leads', requestID, [event(0, `START RequestId: ${runID} Version: $LATEST\n`)]);

    expect(run?.outcome).toBe('running');
  });

  test.each([
    ['a REPORT line with a timeout status', [event(60_000, report(runID, 'Status: timeout'))], 'timeout'],
    [
      'a line of the runtime that the run timed out',
      [event(60_000, `2026-10-13T17:16:34.000Z ${runID} Task timed out after 60.00 seconds`)],
      'timeout',
    ],
    [
      'a REPORT line with an error status',
      [event(10, report(runID, 'Status: error\tError Type: Runtime.ExitError'))],
      'failed',
    ],
    [
      'an error that the handler threw',
      [event(5, codeLine(5, 'Invoke Error \t{}', runID, 'ERROR')), event(10, report(runID, ''))],
      'failed',
    ],
    [
      'an error that the handler logged and handled',
      [event(5, codeLine(5, '[17:15:34.120] ERROR (#2): Unauthorized')), event(10, report(runID, ''))],
      'ended',
    ],
  ])('end after %s', (_, events, outcome) => {
    expect(toRuns('inbox', requestID, events)[0]?.outcome).toBe(outcome);
  });

  test('keep the progress writes, and count the other requests of the same run', () => {
    const [run] = toRuns('leads', requestID, [
      event(1, progressLine(1, requestID, { leadsPending: 10 })),
      event(2, progressLine(2, 'otherrequest0000000000000000000000000000', { leadsPending: 3 })),
      event(3, progressLine(3, requestID, { leadsPending: -10, leadsProcessed: 10 })),
      event(4, codeLine(4, '[17:15:34.120] WARN (#2): []')),
    ]);

    expect(run?.lines[0]?.progress).toEqual({ requestID, change: { leadsPending: 10 } });
    expect(run?.otherRequests).toBe(1);
    expect(run?.warnings).toBe(1);
    expect(run?.errors).toBe(0);
  });

  test('keep the size of a file that a run read', () => {
    const size = { kind: 'email', key: `received/${requestID}`, bytes: 300_000 };
    const [run] = toRuns('inbox', requestID, [event(1, fileSizeLine(1, requestID, size))]);

    expect(run?.lines[0]).toMatchObject({ level: 'info', fileSize: { requestID, size } });
    expect(run?.lines[0]?.progress).toBeUndefined();
  });

  test('are oldest first, and each has only its own lines', () => {
    const later = '442edb0c-ad2e-5584-868a-b84bafd22c2a';
    const runs = toRuns('leads', requestID, [
      event(9000, `START RequestId: ${later} Version: $LATEST\n`, 'other stream'),
      event(0, `START RequestId: ${runID} Version: $LATEST\n`),
      event(5, progressLine(5, requestID, { leadsPending: 10 })),
      event(9005, progressLine(9005, requestID, { leadsPending: 5 }, later)),
    ]);

    expect(runs.map((run) => [run.runID, run.lines.length, run.logStream])).toEqual([
      [runID, 2, '2026/10/13/[$LATEST]f865b09b5180'],
      [later, 2, 'other stream'],
    ]);
  });

  test('keep at most the line limit of a run', () => {
    const lines = Array.from({ length: runLineLimit + 5 }, (_, index) =>
      event(index, codeLine(index, `[17:15:34.120] INFO (#2): line ${index}`))
    );
    const [run] = toRuns('leads', requestID, lines);

    expect(run?.lines).toHaveLength(runLineLimit);
    expect(run?.truncated).toBe(true);
  });
});

describe('the time to search for the runs of a request', () => {
  const now = Date.parse('2026-10-13T18:00:00.000Z');

  test('starts before the email came in and ends after the last change', () => {
    const window = searchWindowOf(
      { receivedAt: '2026-10-13T17:15:34.000Z', updatedAt: '2026-10-13T17:16:00.000Z', state: 'done' },
      now
    );

    expect(window).toEqual({ from: new Date('2026-10-13T17:13:34.000Z'), to: new Date('2026-10-13T17:18:00.000Z') });
  });

  test('of an active request ends now, because a run can still write', () => {
    const window = searchWindowOf(
      { receivedAt: '2026-10-13T17:15:34.000Z', updatedAt: '2026-10-13T17:16:00.000Z', state: 'active' },
      now
    );

    expect(window.to).toEqual(new Date(now));
  });

  test('of a standalone source starts an hour before its last change', () => {
    const window = searchWindowOf({ updatedAt: '2026-10-13T17:16:00.000Z', state: 'done' }, now);

    expect(window.from).toEqual(new Date('2026-10-13T16:14:00.000Z'));
  });

  test('is never longer than the longest search, and keeps the end of the request', () => {
    const window = searchWindowOf(
      { receivedAt: '2026-10-01T17:15:34.000Z', updatedAt: '2026-10-13T17:16:00.000Z', state: 'active' },
      now
    );

    expect(window).toEqual({ from: new Date(now - longestSearchMs), to: new Date(now) });
  });
});
