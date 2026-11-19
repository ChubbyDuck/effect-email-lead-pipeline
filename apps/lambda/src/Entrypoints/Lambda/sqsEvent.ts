import type { S3Event, S3EventRecord, SQSRecord } from 'aws-lambda';

import { recordsFromEvent } from './s3Event';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const recordsFromMessage = (message: SQSRecord): S3EventRecord[] => {
  const event: unknown = JSON.parse(message.body);
  if (!isObject(event)) throw new Error('Invalid S3 notification');
  // S3 sends a differently shaped test notification when the destination is configured.
  if (event.Service === 'Amazon S3' && event.Event === 's3:TestEvent') return [];
  if (!Array.isArray(event.Records) || event.Records.length === 0) throw new Error('S3 event has no records');
  for (const record of event.Records) {
    if (
      !isObject(record) ||
      !isObject(record.s3) ||
      !isObject(record.s3.bucket) ||
      typeof record.s3.bucket.name !== 'string' ||
      !isObject(record.s3.object) ||
      typeof record.s3.object.key !== 'string'
    ) {
      throw new Error('Invalid S3 notification record');
    }
  }
  return recordsFromEvent(event as unknown as S3Event);
};
