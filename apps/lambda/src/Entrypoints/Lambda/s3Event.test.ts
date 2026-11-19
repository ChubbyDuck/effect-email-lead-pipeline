import type { S3EventRecord } from 'aws-lambda';
import { describe, expect, test } from 'vitest';

import { receivedAtFromRecord } from './s3Event';

describe('receivedAtFromRecord', () => {
  const record = (eventTime: unknown) => ({ eventTime }) as unknown as S3EventRecord;

  test('reads the S3 event time', () => {
    expect(receivedAtFromRecord(record('2026-09-27T14:37:12.345Z'))).toEqual(new Date('2026-09-27T14:37:12.345Z'));
  });

  test.each([undefined, '', 'not a date'])('rejects the event time %j', (eventTime) => {
    expect(() => receivedAtFromRecord(record(eventTime))).toThrow('S3 notification record has no valid eventTime');
  });
});
