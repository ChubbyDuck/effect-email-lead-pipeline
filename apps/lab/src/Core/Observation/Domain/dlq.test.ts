import { expect, test } from 'vitest';

import { bodyOf, deadLettersOf, type DlqMessages, pickRun, subjectOf, toDlqMessage } from './dlq';
import type { HandlerRun } from './runs';

test('parses a JSON body, and keeps a body that is not JSON as text', () => {
  expect(bodyOf('{"key":"sources/a.pdf"}')).toEqual({ key: 'sources/a.pdf' });
  expect(bodyOf('not json')).toBe('not json');
  expect(bodyOf('')).toBe('');
});

test('converts an SQS message, with its attributes and its message attributes', () => {
  expect(
    toDlqMessage({
      MessageId: 'm1',
      Body: '{"requestID":"r1"}',
      Attributes: { ApproximateReceiveCount: '2', SentTimestamp: '1760000000000' },
      MessageAttributes: {
        kind: { DataType: 'String', StringValue: 'source' },
        raw: { DataType: 'Binary', BinaryValue: new Uint8Array([104, 105]) },
      },
    })
  ).toEqual({
    messageId: 'm1',
    attributes: { ApproximateReceiveCount: '2', SentTimestamp: '1760000000000' },
    messageAttributes: {
      kind: { dataType: 'String', value: 'source' },
      raw: { dataType: 'Binary', value: 'aGk=' },
    },
    body: { requestID: 'r1' },
  });
});

test('leaves out the message attributes when the message has none', () => {
  expect(toDlqMessage({ MessageId: 'm2', Body: 'text' })).toEqual({ messageId: 'm2', attributes: {}, body: 'text' });
});

test('names a message by the keys of its S3 event, or else by its body', () => {
  const message = (body: string) => toDlqMessage({ MessageId: 'm', Body: body });
  const object = (key: string) => ({ s3: { bucket: { name: 'sources' }, object: { key } } });
  const event = { Records: [object('a.pdf'), object('b.pdf')] };

  expect(subjectOf(message(JSON.stringify(event)))).toBe('a.pdf, b.pdf');
  expect(subjectOf(message('{"lead":{"name":"Ann"}}'))).toBe('{"lead":{"name":"Ann"}}');
  expect(subjectOf(message('plain text'))).toBe('plain text');
});

const receivedAt = Date.parse('2026-10-13T21:30:01.800Z');

const run = (runID: string, startAfterMs: number, outcome: HandlerRun['outcome'] = 'ended'): HandlerRun => ({
  stage: 'leadSources',
  runID,
  logStream: 'stream',
  startedAt: new Date(receivedAt + startAfterMs).toISOString(),
  outcome,
  errors: 0,
  warnings: 0,
  otherRequests: 0,
  logBytes: 0,
  lines: [],
  truncated: false,
});

test('picks the failed run that started nearest to the receive', () => {
  const runs = [run('ok', 50), run('far', 10_000, 'failed'), run('near', 400, 'timeout')];

  expect(pickRun(runs, receivedAt)).toEqual({ run: runs[2], candidates: 2 });
});

test('picks no run that ended without a failure, because that run released its messages', () => {
  expect(pickRun([run('ok', 50)], receivedAt)).toBeUndefined();
  expect(pickRun([{ ...run('logged', 50), errors: 1 }], receivedAt)?.run.runID).toBe('logged');
});

test('picks no run that started long before or after the receive', () => {
  expect(pickRun([run('before', -5_000, 'failed'), run('after', 60_000, 'failed')], receivedAt)).toBeUndefined();
});

test('counts the DLQ messages of each request by stage', () => {
  const dlq = (stage: DlqMessages['stage'], requestIDs: readonly (readonly string[])[]): DlqMessages => ({
    deployment: 'test',
    region: 'eu-north-1',
    stage,
    queueName: `q-${stage}`,
    readAt: '2026-10-14T10:00:00.000Z',
    approximateCount: requestIDs.length,
    messages: requestIDs.map((ids, index) => ({
      message: { messageId: `${stage}-${index}`, attributes: {}, body: null },
      objects: [],
      requestIDs: ids,
    })),
  });

  expect(
    deadLettersOf([dlq('leads', [['a'], ['a'], ['b'], []]), dlq('leadSources', [['a', 'c']]), dlq('inbox', [])])
  ).toEqual({ a: { leads: 2, leadSources: 1 }, b: { leads: 1 }, c: { leadSources: 1 } });
});
