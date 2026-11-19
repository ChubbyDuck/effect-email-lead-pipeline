import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { beforeEach, expect, test, vi } from 'vitest';

import { makeSqsS3LevelSource } from './levels';

const sqsSend = vi.fn();
const s3Send = vi.fn();
const sqs = { send: sqsSend } as unknown as SQSClient;
const s3 = { send: s3Send } as unknown as S3Client;

beforeEach(() => {
  sqsSend.mockReset();
  s3Send.mockReset();
  sqsSend.mockImplementation(async (command: unknown) => {
    if (command instanceof GetQueueUrlCommand) return { QueueUrl: `https://sqs/${command.input.QueueName}` };
    if (command instanceof GetQueueAttributesCommand) {
      return command.input.QueueUrl === 'https://sqs/leads-inbox-dlq'
        ? { Attributes: { ApproximateNumberOfMessages: '1' } }
        : { Attributes: { ApproximateNumberOfMessagesNotVisible: '0' } };
    }
    throw new Error('unexpected command');
  });
  s3Send.mockImplementation(async (command: unknown) => {
    if (!(command instanceof ListObjectsV2Command)) throw new Error('unexpected command');
    return command.input.Bucket === 'leads-inbox'
      ? { Contents: [{ Key: 'email-1', LastModified: new Date('2026-10-14T15:00:00Z'), Size: 10 }] }
      : { Contents: [] };
  });
});

test('reads the counts of each queue and the objects of each bucket', async () => {
  const levels = await makeSqsS3LevelSource(sqs, s3, 'leads').read();

  expect(levels.queues.ok && levels.queues.value).toContainEqual({
    stage: 'inbox',
    role: 'dlq',
    visible: 1,
    inFlight: 0,
    delayed: 0,
  });
  expect(levels.queues.ok && levels.queues.value).toHaveLength(6);
  expect(levels.buckets).toEqual({
    ok: true,
    value: [
      {
        name: 'leads-inbox',
        stage: 'inbox',
        objects: [{ key: 'email-1', lastModified: '2026-10-14T15:00:00.000Z', size: 10 }],
        truncated: false,
      },
      { name: 'leads-lead-sources', stage: 'leadSources', objects: [], truncated: false },
    ],
  });
});

test('looks up the URL of each queue only once', async () => {
  const source = makeSqsS3LevelSource(sqs, s3, 'leads');
  await source.read();
  await source.read();

  const lookups = sqsSend.mock.calls.filter(([command]: unknown[]) => command instanceof GetQueueUrlCommand);
  expect(lookups).toHaveLength(6);
});

test('keeps the buckets when the queues cannot be read', async () => {
  sqsSend.mockRejectedValue(new Error('denied'));

  const levels = await makeSqsS3LevelSource(sqs, s3, 'leads').read();

  expect(levels.queues).toEqual({ ok: false, error: 'Error: denied' });
  expect(levels.buckets.ok).toBe(true);
});
