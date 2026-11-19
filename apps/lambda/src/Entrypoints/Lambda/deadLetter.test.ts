import { ChangeMessageVisibilityCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { SQSRecord } from 'aws-lambda';
import { beforeEach, expect, test, vi } from 'vitest';

import { makeReleaseFailedRecords } from './deadLetter';

const record = (index: number, queue = 'leads-leads'): SQSRecord => ({
  messageId: `message-${index}`,
  receiptHandle: `receipt-${index}`,
  body: '{}',
  attributes: {
    ApproximateReceiveCount: '1',
    SentTimestamp: '0',
    SenderId: 'LeadSourcesHandler',
    ApproximateFirstReceiveTimestamp: '0',
  },
  messageAttributes: {},
  md5OfBody: '',
  eventSource: 'aws:sqs',
  eventSourceARN: `arn:aws:sqs:eu-north-1:000000000000:${queue}`,
  awsRegion: 'eu-north-1',
});

const send = vi.fn();
const sqs = { send } as unknown as SQSClient;

const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

beforeEach(() => {
  info.mockClear();
  send.mockReset();
  send.mockImplementation(async (command: unknown) =>
    command instanceof GetQueueUrlCommand ? { QueueUrl: `https://sqs/${command.input.QueueName}` } : {}
  );
});

const visibilityChanges = () =>
  send.mock.calls
    .map(([command]: unknown[]) => command)
    .filter((command) => command instanceof ChangeMessageVisibilityCommand)
    .map((command) => command.input);

test('makes each failed record visible at once, so the next receive moves it to the DLQ', async () => {
  await makeReleaseFailedRecords(sqs)([record(1), record(2, 'leads-inbox')]);

  expect(visibilityChanges()).toEqual([
    { QueueUrl: 'https://sqs/leads-leads', ReceiptHandle: 'receipt-1', VisibilityTimeout: 0 },
    { QueueUrl: 'https://sqs/leads-inbox', ReceiptHandle: 'receipt-2', VisibilityTimeout: 0 },
  ]);
});

test('looks up the URL of a queue once', async () => {
  const release = makeReleaseFailedRecords(sqs);
  await release([record(1)]);
  await release([record(2)]);

  expect(send.mock.calls.filter(([command]: unknown[]) => command instanceof GetQueueUrlCommand)).toHaveLength(1);
});

test('logs a release that fails and releases the other records', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof GetQueueUrlCommand) return { QueueUrl: 'https://sqs/leads-leads' };
    if (command instanceof ChangeMessageVisibilityCommand && command.input.ReceiptHandle === 'receipt-1')
      throw new Error('receipt expired');
    return {};
  });

  await expect(makeReleaseFailedRecords(sqs)([record(1), record(2)])).resolves.toBeUndefined();

  expect(visibilityChanges().map(({ ReceiptHandle }) => ReceiptHandle)).toEqual(['receipt-1', 'receipt-2']);
  expect(error).toHaveBeenCalledExactlyOnceWith('Could not release message message-1', expect.any(Error));
  error.mockRestore();
});

test('logs the ID of each failed record before the release, so that the monitor can find the run that failed it', async () => {
  send.mockRejectedValue(new Error('SQS is down'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await makeReleaseFailedRecords(sqs)([record(1), record(2, 'leads-inbox')]);

  expect(info.mock.calls).toEqual([
    ['Message message-1 of arn:aws:sqs:eu-north-1:000000000000:leads-leads goes to the DLQ'],
    ['Message message-2 of arn:aws:sqs:eu-north-1:000000000000:leads-inbox goes to the DLQ'],
  ]);
  error.mockRestore();
});
