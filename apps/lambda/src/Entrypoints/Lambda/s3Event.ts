import { File } from '@leads/shared/domain/types';
import type { S3Event, S3EventRecord } from 'aws-lambda';

export const recordsFromEvent = (event: S3Event): S3EventRecord[] => {
  if (!Array.isArray(event.Records) || event.Records.length === 0) {
    throw new Error('S3 event has no records');
  }
  return event.Records;
};

export const fileFromRecord = (record: S3EventRecord): File =>
  File.make({
    bucket: record.s3.bucket.name,
    key: decodeURIComponent(record.s3.object.key.replace(/\+/g, ' ')),
  });

/** When S3 stored the object. A duplicate notification and a DLQ redrive carry the same time. */
export const receivedAtFromRecord = (record: S3EventRecord): Date => {
  const receivedAt = new Date(record.eventTime);
  if (Number.isNaN(receivedAt.getTime())) throw new Error('S3 notification record has no valid eventTime');
  return receivedAt;
};
