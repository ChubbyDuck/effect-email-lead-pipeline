import { ChangeMessageVisibilityCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SQSRecord } from 'aws-lambda';

import { flociEndpoint } from './flociEndpoint';

/**
 * The line that links a DLQ message to the run that failed it. SQS keeps the ID of a message when it moves the message
 * to its DLQ, and Lambda puts the ID of the run on the line. The monitor searches the logs for the message ID.
 */
export const deadLetterLogMessage = (record: Pick<SQSRecord, 'messageId' | 'eventSourceARN'>) =>
  `Message ${record.messageId} of ${record.eventSourceARN} goes to the DLQ`;

/**
 * Makes failed records visible at once. Each queue allows one receive, so the next receive moves each record to its DLQ.
 * Without this, a failed record waits for the full visibility timeout of its queue.
 * A release that fails only logs: its record then moves to the DLQ when the visibility timeout ends.
 */
export const makeReleaseFailedRecords = (sqs: SQSClient) => {
  const queueUrls = new Map<string, string>();
  const queueUrlOf = async (queueArn: string): Promise<string> => {
    const known = queueUrls.get(queueArn);
    if (known !== undefined) return known;
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueArn.split(':').at(-1) }));
    if (QueueUrl === undefined) throw new Error(`No queue URL for ${queueArn}`);
    queueUrls.set(queueArn, QueueUrl);
    return QueueUrl;
  };

  return async (records: readonly SQSRecord[]): Promise<void> => {
    // Before the release: a record whose release fails still goes to the DLQ, later.
    for (const record of records) console.info(deadLetterLogMessage(record));
    const results = await Promise.allSettled(
      records.map(async (record) =>
        sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: await queueUrlOf(record.eventSourceARN),
            ReceiptHandle: record.receiptHandle,
            VisibilityTimeout: 0,
          })
        )
      )
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`Could not release message ${records[index]?.messageId}`, result.reason);
      }
    });
  };
};

// One client per execution environment. It sends requests only when a handler fails.
export const releaseFailedRecords = makeReleaseFailedRecords(
  new SQSClient(flociEndpoint === undefined ? {} : { endpoint: flociEndpoint, useQueueUrlAsEndpoint: false })
);
