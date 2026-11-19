import { handler as handleInbox } from '@leads/pipeline/application/HandleInbox/handler';
import type { Context, SQSRecord } from 'aws-lambda';
import { Effect } from 'effect';
import { beforeEach, expect, test, vi } from 'vitest';

import { releaseFailedRecords } from './deadLetter';
import { handler } from './inbox';

vi.mock('@leads/pipeline/application/HandleInbox/handler', () => ({ handler: vi.fn() }));
vi.mock('./deadLetter', () => ({ releaseFailedRecords: vi.fn(async () => undefined) }));
vi.mock('./services', async () => {
  const { Layer } = await import('effect');
  return { LambdaServicesLive: Layer.empty };
});

const context = {
  functionName: 'InboxHandler',
  getRemainingTimeInMillis: () => 60_000,
} as Context;

const message = (body: string): SQSRecord => ({
  messageId: 'message-1',
  receiptHandle: 'receipt-1',
  body,
  attributes: {
    ApproximateReceiveCount: '1',
    SentTimestamp: '0',
    SenderId: 's3',
    ApproximateFirstReceiveTimestamp: '0',
  },
  messageAttributes: {},
  md5OfBody: '',
  eventSource: 'aws:sqs',
  eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:leads-inbox',
  awsRegion: 'us-east-1',
});

const eventTime = '2026-09-27T14:37:12.345Z';
const messageID = 'o3vrnil0e2ic28trm7dfhrc2v0clambda4nbp0g1';

const notificationFor = (key: string, record: Record<string, unknown> = { eventTime }) =>
  JSON.stringify({
    Records: [{ eventSource: 'aws:s3', ...record, s3: { bucket: { name: 'inbox' }, object: { key } } }],
  });
const notification = notificationFor('received/hello+world%2B.eml');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(handleInbox).mockReturnValue(Effect.void);
});

test('unwraps the S3 notification from SQS and decodes the email key', async () => {
  await handler({ Records: [message(notification)] }, context);

  expect(handleInbox).toHaveBeenCalledExactlyOnceWith({
    bucket: 'inbox',
    key: 'received/hello world+.eml',
    receivedAt: new Date(eventTime),
    functionName: 'InboxHandler',
  });
});

test('passes the key that names the SES message and the folder time from the S3 event', async () => {
  await handler({ Records: [message(notificationFor(`received/${messageID}`))] }, context);

  expect(handleInbox).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ key: `received/${messageID}`, receivedAt: new Date(eventTime) })
  );
});

test('gives a redelivered notification the same command', async () => {
  await handler({ Records: [message(notification)] }, context);
  await handler({ Records: [message(notification)] }, context);

  const [first, second] = vi.mocked(handleInbox).mock.calls.map(([command]) => command);
  expect(second).toEqual(first);
});

test('rejects a notification record without eventTime so the queue message is not acknowledged', async () => {
  await expect(handler({ Records: [message(notificationFor('received/mail.eml', {}))] }, context)).rejects.toThrow(
    'S3 notification record has no valid eventTime'
  );
  expect(handleInbox).not.toHaveBeenCalled();
});

test('acknowledges the S3 destination test notification without processing an email', async () => {
  await handler({ Records: [message(JSON.stringify({ Service: 'Amazon S3', Event: 's3:TestEvent' }))] }, context);

  expect(handleInbox).not.toHaveBeenCalled();
});

test.each(['not json', 'null', '{}', '{"Records":[]}', '{"Records":[{}]}'])(
  'rejects malformed notification %s so SQS can retry it',
  async (body) => {
    await expect(handler({ Records: [message(body)] }, context)).rejects.toThrow(/JSON|S3/);
    expect(handleInbox).not.toHaveBeenCalled();
  }
);

test('rejects an empty SQS event', async () => {
  await expect(handler({ Records: [] }, context)).rejects.toThrow('SQS event has no records');
});

test('propagates an uncaught processing failure so the queue message is not acknowledged', async () => {
  vi.mocked(handleInbox).mockReturnValue(Effect.die(new Error('storage unavailable')));

  await expect(handler({ Records: [message(notification)] }, context)).rejects.toThrow('storage unavailable');
});

test('releases the failed message before it reports the failure', async () => {
  vi.mocked(handleInbox).mockReturnValue(Effect.die(new Error('storage unavailable')));
  const record = message(notification);

  await expect(handler({ Records: [record] }, context)).rejects.toThrow('storage unavailable');
  expect(releaseFailedRecords).toHaveBeenCalledExactlyOnceWith([record]);
});

test('releases nothing when the message is handled', async () => {
  await handler({ Records: [message(notification)] }, context);

  expect(releaseFailedRecords).not.toHaveBeenCalled();
});
