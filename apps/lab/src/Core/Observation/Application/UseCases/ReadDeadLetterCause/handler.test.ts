import { describe, expect, it } from 'vitest';

import type { RawLogEvent } from '#Core/Observation/Domain/runs';
import { logGroupOf, makeLogSearch } from '#Core/Observation/Ports/testing/logSearch';

import type { Command } from './command';
import { handler } from './handler';

const receivedAt = Date.parse('2026-10-18T12:00:00.000Z');
const command: Command = {
  stage: 'leads',
  messageId: '5fb1c0de-6b41-4c39-9d43-8d3e0f9b2a11',
  receivedAt: new Date(receivedAt),
  requestIDs: ['r1', 'r2'],
};

const runID = (index: number) => `20b3ae96-eb9e-5c4b-ab2f-${String(index).padStart(12, '0')}`;

const event = (offsetMs: number, message: string): RawLogEvent => ({
  timestamp: receivedAt + offsetMs,
  message,
  logStream: 'stream',
});

const codeLine = (offsetMs: number, id: string, text: string, level = 'INFO') =>
  event(offsetMs, `${new Date(receivedAt + offsetMs).toISOString()}\t${id}\t${level}\t${text}\n`);

const report = (offsetMs: number, id: string, status: string) =>
  event(
    offsetMs,
    `REPORT RequestId: ${id}\tDuration: 50.00 ms\tBilled Duration: 50 ms\tMemory Size: 128 MB\tMax Memory Used: 90 MB\tStatus: ${status}\n`
  );

/** A run that starts `offsetMs` after the receive, logs `texts`, and ends with `status`. */
const runOf = (id: string, offsetMs: number, texts: readonly string[], status = 'error'): RawLogEvent[] => [
  event(offsetMs, `START RequestId: ${id} Version: $LATEST\n`),
  ...texts.map((text, index) => codeLine(offsetMs + index + 1, id, `[12:00:00.000] INFO (#3): ${text}`)),
  report(offsetMs + 50, id, status),
];

const progressOf = (requestID: string) => `Progress of request ${requestID}: {"leadsFailed":1}`;
const sentToDlq = `Message ${command.messageId} goes to the DLQ`;

const causeOf = (events: readonly RawLogEvent[]) => {
  const search = makeLogSearch({ events: { leads: events }, timeoutSeconds: 300 });
  return { cause: handler(command, { logs: search.logs }), searches: search.searches };
};

describe('ReadDeadLetterCause', () => {
  it('gives the run that names the message, also when it started far from the receive', async () => {
    const { cause } = causeOf([
      ...runOf(runID(1), 1_000, [progressOf('r1')]),
      ...runOf(runID(2), 200_000, [progressOf('r1'), sentToDlq]),
    ]);

    expect((await cause).found).toMatchObject({ basis: { kind: 'message' }, run: { runID: runID(2) }, candidates: 1 });
  });

  it('gives the failed run of a request nearest to the receive, when no run names the message', async () => {
    const { cause } = causeOf([
      ...runOf(runID(1), 20_000, [progressOf('r1')]),
      ...runOf(runID(2), 3_000, [progressOf('r1')]),
      ...runOf(runID(3), 1_000, [progressOf('r1')], 'success'),
    ]);

    expect((await cause).found).toMatchObject({
      basis: { kind: 'request', requestID: 'r1' },
      run: { runID: runID(2) },
      candidates: 2,
    });
  });

  it('tries the next request when no failed run of the first one fits', async () => {
    const { cause } = causeOf([
      ...runOf(runID(1), 1_000, [progressOf('r1')], 'success'),
      ...runOf(runID(2), 2_000, [progressOf('r2')]),
    ]);

    expect((await cause).found).toMatchObject({
      basis: { kind: 'request', requestID: 'r2' },
      run: { runID: runID(2) },
    });
  });

  it('gives the failed run nearest to the receive, when the run failed before it logged a request', async () => {
    const { cause } = causeOf([
      ...runOf(runID(1), 1_000, ['Read the batch']),
      codeLine(1_010, runID(1), 'Invoke Error \t{}', 'ERROR'),
      ...runOf(runID(2), 60_000, ['Read the batch']),
    ]);

    expect((await cause).found).toMatchObject({ basis: { kind: 'time' }, run: { runID: runID(1) }, candidates: 1 });
  });

  it('gives no run when no failed run started near the receive', async () => {
    const { cause } = causeOf([...runOf(runID(1), 120_000, [progressOf('r1')])]);

    expect(await cause).toEqual({
      messageId: command.messageId,
      deployment: 'production-cdk',
      region: 'eu-north-1',
      logGroup: logGroupOf('leads'),
      from: '2026-10-18T11:59:00.000Z',
      to: '2026-10-18T12:06:00.000Z',
    });
  });

  it('searches from a minute before the receive to a minute after the timeout of the handler', async () => {
    const { cause, searches } = causeOf([]);
    await cause;

    expect(searches.map(({ terms, from, to }) => ({ terms, from: from.toISOString(), to: to.toISOString() }))).toEqual(
      [[command.messageId], ['r1'], ['r2'], ['ERROR', 'Task timed out', 'Status: error', 'Status: timeout']].map(
        (terms) => ({ terms, from: '2026-10-18T11:59:00.000Z', to: '2026-10-18T12:06:00.000Z' })
      )
    );
  });
});
