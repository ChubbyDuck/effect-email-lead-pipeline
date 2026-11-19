import { handler as handleLeadSources } from '@leads/pipeline/application/HandleLeadSources/handler';
import type { Context, SQSRecord } from 'aws-lambda';
import { Effect } from 'effect';
import { beforeEach, expect, test, vi } from 'vitest';

import { releaseFailedRecords } from './deadLetter';
import { handler } from './leadSources';

vi.mock('@leads/pipeline/application/HandleLeadSources/handler', () => ({ handler: vi.fn() }));
vi.mock('./deadLetter', () => ({ releaseFailedRecords: vi.fn(async () => undefined) }));
vi.mock('./leadSourcesServices', async () => {
  const { Layer } = await import('effect');
  return { LeadSourcesServicesLive: Layer.empty };
});

const context = {
  functionName: 'LeadSourcesHandler',
  getRemainingTimeInMillis: () => 300_000,
} as Context;

const requestID = 'o3vrnil0e2ic28trm7dfhrc2v0clambda4nbp0g1';
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
  eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:leads-lead-sources',
  awsRegion: 'us-east-1',
});

const notification = JSON.stringify({
  Records: [
    {
      eventSource: 'aws:s3',
      eventTime: '2026-09-27T14:37:12.345Z',
      s3: { bucket: { name: 'lead-sources' }, object: { key: `received/${requestID}/Business+Closure%2B.xlsx` } },
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(handleLeadSources).mockReturnValue(Effect.void);
});

test('unwraps the S3 notification from SQS and decodes the workbook key', async () => {
  await handler({ Records: [message(notification)] }, context);

  expect(handleLeadSources).toHaveBeenCalledExactlyOnceWith({
    bucket: 'lead-sources',
    key: `received/${requestID}/Business Closure+.xlsx`,
    functionName: 'LeadSourcesHandler',
  });
});

test('handles a notification record without eventTime, because the sources handler does not use the time', async () => {
  const record = { s3: { bucket: { name: 'lead-sources' }, object: { key: `received/${requestID}/leads.xlsx` } } };

  await handler({ Records: [message(JSON.stringify({ Records: [record] }))] }, context);

  expect(handleLeadSources).toHaveBeenCalledExactlyOnceWith({
    bucket: 'lead-sources',
    key: `received/${requestID}/leads.xlsx`,
    functionName: 'LeadSourcesHandler',
  });
});

test('acknowledges the S3 destination test notification without processing a workbook', async () => {
  await handler({ Records: [message(JSON.stringify({ Service: 'Amazon S3', Event: 's3:TestEvent' }))] }, context);

  expect(handleLeadSources).not.toHaveBeenCalled();
});

test.each(['not json', 'null', '{}', '{"Records":[]}', '{"Records":[{}]}'])(
  'rejects malformed notification %s so SQS can retry it',
  async (body) => {
    await expect(handler({ Records: [message(body)] }, context)).rejects.toThrow(/JSON|S3/);
    expect(handleLeadSources).not.toHaveBeenCalled();
  }
);

test('rejects an empty SQS event', async () => {
  await expect(handler({ Records: [] }, context)).rejects.toThrow('SQS event has no records');
});

test('waits for workbook processing before acknowledging the queue message', async () => {
  let finish!: () => void;
  vi.mocked(handleLeadSources).mockReturnValue(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    )
  );
  let completed = false;
  const invocation = handler({ Records: [message(notification)] }, context).then(() => {
    completed = true;
  });

  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(completed).toBe(false);
  finish();
  await invocation;
  expect(completed).toBe(true);
});

test('propagates an uncaught processing failure so the queue message is not acknowledged', async () => {
  vi.mocked(handleLeadSources).mockReturnValue(Effect.die(new Error('storage unavailable')));

  await expect(handler({ Records: [message(notification)] }, context)).rejects.toThrow('storage unavailable');
});

test('releases the failed message before it reports the failure', async () => {
  vi.mocked(handleLeadSources).mockReturnValue(Effect.die(new Error('storage unavailable')));
  const record = message(notification);

  await expect(handler({ Records: [record] }, context)).rejects.toThrow('storage unavailable');
  expect(releaseFailedRecords).toHaveBeenCalledExactlyOnceWith([record]);
});

test('releases nothing when the message is handled', async () => {
  await handler({ Records: [message(notification)] }, context);

  expect(releaseFailedRecords).not.toHaveBeenCalled();
});
