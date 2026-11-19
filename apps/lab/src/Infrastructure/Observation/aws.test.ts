import { expect, test } from 'vitest';

import { queueLimits, toLogEvent } from './aws';

test('reads the run and the message of a Lambda log line, without the prefix of Effect', () => {
  const event = toLogEvent(
    'leadSources',
    Date.parse('2026-10-09T13:41:40.279Z'),
    '2026-10-09T13:41:40.279Z\td39dd6e9-9b3d-5bbc-a4da-b5ab6a792f71\tINFO\t[13:41:40.278] WARN (#20): Runtime settings are stale\n'
  );

  expect(event).toEqual({
    stage: 'leadSources',
    time: '2026-10-09T13:41:40.279Z',
    level: 'warn',
    requestId: 'd39dd6e9-9b3d-5bbc-a4da-b5ab6a792f71',
    message: 'Runtime settings are stale',
  });
});

test.each([
  ['2026-10-09T13:41:40.332Z\td39dd6e9-9b3d-5bbc-a4da-b5ab6a792f71\tERROR\tInvoke Error \t{}'],
  ['2026-10-09T13:41:40.332Z d39dd6e9-9b3d-5bbc-a4da-b5ab6a792f71 Task timed out after 300.00 seconds'],
  ['2026-10-09T13:41:40.332Z\td39dd6e9-9b3d-5bbc-a4da-b5ab6a792f71\tINFO\t[13:41:40.278] ERROR (#2): Send failed'],
  ['2026-10-09T13:41:40.332Z\tundefined\tERROR\tUncaught Exception \t{"errorType":"Error"}'],
])('classifies %j as an error', (line) => {
  expect(toLogEvent('inbox', 0, line).level).toBe('error');
});

test('classifies a line of Effect by its level, not by the words of its message', () => {
  const line =
    '2026-10-09T13:41:40.332Z\td39dd6e9-9b3d-5bbc-a4da-b5ab6a792f71\tINFO\t[13:41:40.278] WARN (#2): ERROR rows: 2';

  expect(toLogEvent('inbox', 0, line)).toMatchObject({ level: 'warn', message: 'ERROR rows: 2' });
});

test('gives no run to a line of the INIT phase', () => {
  const event = toLogEvent('inbox', 0, '2026-10-09T13:41:40.332Z\tundefined\tERROR\tUncaught Exception \t{}');

  expect(event.requestId).toBeUndefined();
  expect(event.message).toBe('Uncaught Exception \t{}');
});

test('reads the retention and the receives before the DLQ from the attributes of a queue', () => {
  expect(
    queueLimits({
      MessageRetentionPeriod: '1209600',
      RedrivePolicy: '{"deadLetterTargetArn":"arn:aws:sqs:eu-north-1:1:leads-dlq","maxReceiveCount":1}',
    })
  ).toEqual({ retentionSeconds: 1_209_600, maxReceiveCount: 1 });
});

test('reads a queue without a DLQ, or with a policy that it cannot parse, without the receives', () => {
  expect(queueLimits({ MessageRetentionPeriod: '345600' })).toEqual({ retentionSeconds: 345_600 });
  expect(queueLimits({ MessageRetentionPeriod: '60', RedrivePolicy: 'not json' })).toEqual({ retentionSeconds: 60 });
});
