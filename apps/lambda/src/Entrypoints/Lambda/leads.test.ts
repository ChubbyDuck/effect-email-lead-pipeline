import { handler as handleLead, LeadNotHandled } from '@leads/pipeline/application/HandleLead/handler';
import type { Context, SQSRecord } from 'aws-lambda';
import { Effect } from 'effect';
import { beforeEach, expect, test, vi } from 'vitest';

import { releaseFailedRecords } from './deadLetter';
import { handler } from './leads';

vi.mock('@leads/pipeline/application/HandleLead/handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@leads/pipeline/application/HandleLead/handler')>()),
  handler: vi.fn(),
}));
vi.mock('./deadLetter', () => ({ releaseFailedRecords: vi.fn(async () => undefined) }));
vi.mock('./services', async () => {
  const { Layer } = await import('effect');
  return { LambdaServicesLive: Layer.empty };
});

const context = {
  functionName: 'LeadHandler',
  invokedFunctionArn: 'arn:aws:lambda:eu-north-1:000000000000:function:LeadHandler',
  functionVersion: '$LATEST',
  getRemainingTimeInMillis: () => 60_000,
} as Context;

const message = (body: string, index = 0): SQSRecord => ({
  messageId: `message-${index}`,
  receiptHandle: `receipt-${index}`,
  body,
  attributes: {
    ApproximateReceiveCount: '1',
    SentTimestamp: '0',
    SenderId: 'LeadSourcesHandler',
    ApproximateFirstReceiveTimestamp: '0',
  },
  messageAttributes: {},
  md5OfBody: '',
  eventSource: 'aws:sqs',
  eventSourceARN: 'arn:aws:sqs:eu-north-1:000000000000:leads-leads',
  awsRegion: 'eu-north-1',
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(handleLead).mockReturnValue(Effect.succeed([]));
});

test('passes the message ID and the body of each SQS record to one command', async () => {
  const records = Array.from({ length: 10 }, (_, index) =>
    message(JSON.stringify({ lead: { name: `lead-${index}` }, requestID: `source-${index}` }), index)
  );
  await expect(handler({ Records: records }, context)).resolves.toEqual({ batchItemFailures: [] });

  expect(handleLead).toHaveBeenCalledExactlyOnceWith({
    records: records.map(({ messageId, body }) => ({ messageId, body })),
    functionName: context.functionName,
    source: `${context.invokedFunctionArn}/${context.functionName}:${context.functionVersion}`,
  });
});

test('passes a malformed message body through for the use case to decode', async () => {
  const records = [message(JSON.stringify({ lead: {} })), message('not json', 1)];
  await handler({ Records: records }, context);

  expect(vi.mocked(handleLead).mock.calls[0]?.[0].records).toEqual([
    { messageId: 'message-0', body: JSON.stringify({ lead: {} }) },
    { messageId: 'message-1', body: 'not json' },
  ]);
});

test('reports the message ids that are not handled so SQS sends them to the DLQ', async () => {
  vi.mocked(handleLead).mockReturnValue(
    Effect.succeed([
      new LeadNotHandled({ messageId: 'message-1', reason: 'unavailable' }),
      new LeadNotHandled({ messageId: 'message-3', reason: 'unavailable' }),
    ])
  );

  await expect(
    handler(
      {
        Records: [0, 1, 2, 3].map((index) => message(JSON.stringify({ lead: { name: `lead-${index}` } }), index)),
      },
      context
    )
  ).resolves.toEqual({
    batchItemFailures: [{ itemIdentifier: 'message-1' }, { itemIdentifier: 'message-3' }],
  });
});

test('rejects an empty SQS event', async () => {
  await expect(handler({ Records: [] }, context)).rejects.toThrow('SQS event has no records');
  expect(handleLead).not.toHaveBeenCalled();
});

test('waits for batch processing before acknowledging the messages', async () => {
  let finish!: () => void;
  vi.mocked(handleLead).mockReturnValue(
    Effect.promise(
      () =>
        new Promise<LeadNotHandled[]>((resolve) => {
          finish = () => resolve([]);
        })
    )
  );
  let completed = false;
  const invocation = handler({ Records: [message(JSON.stringify({ lead: {} }))] }, context).then(() => {
    completed = true;
  });

  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(completed).toBe(false);
  finish();
  await invocation;
  expect(completed).toBe(true);
});

test('propagates a processing failure so the entire batch can be retried', async () => {
  vi.mocked(handleLead).mockReturnValue(Effect.die(new Error('batch processing failed')));

  await expect(handler({ Records: [message(JSON.stringify({ lead: {} }))] }, context)).rejects.toThrow(
    'batch processing failed'
  );
});

test('releases only the messages that are not handled', async () => {
  vi.mocked(handleLead).mockReturnValue(
    Effect.succeed([new LeadNotHandled({ messageId: 'message-1', reason: 'unavailable' })])
  );
  const records = [0, 1, 2].map((index) => message(JSON.stringify({ lead: { name: `lead-${index}` } }), index));

  await handler({ Records: records }, context);

  expect(releaseFailedRecords).toHaveBeenCalledExactlyOnceWith([records[1]]);
});

test('releases the entire batch when processing fails', async () => {
  vi.mocked(handleLead).mockReturnValue(Effect.die(new Error('batch processing failed')));
  const records = [message(JSON.stringify({ lead: {} })), message(JSON.stringify({ lead: {} }), 1)];

  await expect(handler({ Records: records }, context)).rejects.toThrow('batch processing failed');
  expect(releaseFailedRecords).toHaveBeenCalledExactlyOnceWith(records);
});
