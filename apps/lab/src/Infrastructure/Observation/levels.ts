import { S3Client } from '@aws-sdk/client-s3';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { stageNames } from '@leads/shared/domain/stages';

import type { QueueLevel } from '#Core/Observation/Domain/levels';
import { section } from '#Core/Observation/Domain/snapshot';
import type { LevelSource } from '#Core/Observation/Ports/LevelSource';

import { type AwsStatusSourceOptions, queueCounts, queueNameOf, readBuckets } from './aws';

/**
 * Reads the levels with the SQS and S3 clients: the counts of each queue, and the objects of each bucket. It keeps the
 * URL of each queue, so that a poll sends only the reads of the counts.
 */
export function makeSqsS3LevelSource(sqs: SQSClient, s3: S3Client, prefix: string): LevelSource {
  const queues = stageNames.flatMap((stage) => (['main', 'dlq'] as const).map((role) => ({ stage, role })));
  const urls = new Map<string, Promise<string>>();

  const urlOf = (queueName: string) => {
    const known = urls.get(queueName);
    if (known !== undefined) return known;
    const url = sqs.send(new GetQueueUrlCommand({ QueueName: queueName })).then(({ QueueUrl }) => QueueUrl ?? '');
    urls.set(queueName, url);
    url.catch(() => urls.delete(queueName));
    return url;
  };

  const readQueues = () =>
    Promise.all(
      queues.map(async ({ stage, role }): Promise<QueueLevel> => {
        const QueueUrl = await urlOf(queueNameOf(prefix, stage, role));
        const { Attributes } = await sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl,
            AttributeNames: [
              'ApproximateNumberOfMessages',
              'ApproximateNumberOfMessagesNotVisible',
              'ApproximateNumberOfMessagesDelayed',
            ],
          })
        );
        return { stage, role, ...queueCounts(Attributes ?? {}) };
      })
    );

  return {
    async read() {
      const readAt = new Date();
      const [queueLevels, buckets] = await Promise.all([section(readQueues), section(() => readBuckets(s3, prefix))]);
      return { readAt: readAt.toISOString(), queues: queueLevels, buckets };
    },
  };
}

export function makeAwsLevelSource({ deployment, endpoint }: AwsStatusSourceOptions): LevelSource {
  const config = { region: deployment.region, ...(endpoint === undefined ? {} : { endpoint }) };
  return makeSqsS3LevelSource(
    new SQSClient(config),
    new S3Client({ ...config, forcePathStyle: endpoint !== undefined }),
    deployment.prefix
  );
}
