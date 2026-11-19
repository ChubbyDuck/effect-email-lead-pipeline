import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { File } from '@leads/shared/domain/types';
import { Effect } from 'effect';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { Storage } from '#Core/Pipeline/Ports/Storage';

import { makeStorageLive } from './live';

const s3 = new S3Client({
  endpoint: process.env.FLOCI_ENDPOINT ?? 'http://127.0.0.1:4566',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  forcePathStyle: true,
});

const sourceBucket = `leads-source-${randomUUID()}`;
const keys = new Map<string, Set<string>>([[sourceBucket, new Set()]]);

const remember = (bucket: string, key: string) => {
  keys.get(bucket)?.add(key);
};

beforeAll(async () => {
  await s3.send(new CreateBucketCommand({ Bucket: sourceBucket }));
});

afterAll(async () => {
  for (const [bucket, objects] of keys) {
    for (const key of objects) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  }
  s3.destroy();
});

test('stores and reads binary data with a key with special characters, then deletes it', async () => {
  const sourceKey = 'received/a file + a symbol.txt';
  const body = Buffer.from([0, 1, 127, 255]);
  remember(sourceBucket, sourceKey);

  await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage;
      const source = File.make({ bucket: sourceBucket, key: sourceKey, body });
      yield* storage.store(source);
      expect((yield* storage.read(sourceBucket, sourceKey)).body).toEqual(body);
      yield* storage.delete(sourceBucket, sourceKey);
    }).pipe(Effect.provide(makeStorageLive(s3)))
  );

  await expect(s3.send(new HeadObjectCommand({ Bucket: sourceBucket, Key: sourceKey }))).rejects.toMatchObject({
    $metadata: { httpStatusCode: 404 },
  });
});

test('store reports a missing bucket while storeSafe logs and continues', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage;
      const file = File.make({ bucket: 'missing-storage-bucket', key: 'object.txt', body: Buffer.from('body') });
      const failure = yield* Effect.flip(storage.store(file));
      expect(failure._tag).toBe('FileNotStored');
      yield* storage.storeSafe(file);
    }).pipe(Effect.provide(makeStorageLive(s3)))
  );
});

test('storeOrSkip stores an empty key once and keeps the first body on a second store', async () => {
  const key = `conditional/${randomUUID()}.txt`;
  remember(sourceBucket, key);

  await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage;
      const first = File.make({ bucket: sourceBucket, key, body: Buffer.from('first') });
      const second = File.make({ bucket: sourceBucket, key, body: Buffer.from('second') });
      expect(yield* storage.storeOrSkip(first)).toBe('stored');
      expect(yield* storage.storeOrSkip(second)).toBe('skipped');
      expect((yield* storage.read(sourceBucket, key)).body).toEqual(Buffer.from('first'));
    }).pipe(Effect.provide(makeStorageLive(s3)))
  );
});

test('storeOrSkip reports a missing bucket as FileNotStored', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage;
      const file = File.make({ bucket: 'missing-storage-bucket', key: 'object.txt', body: Buffer.from('body') });
      const failure = yield* Effect.flip(storage.storeOrSkip(file));
      expect(failure._tag).toBe('FileNotStored');
    }).pipe(Effect.provide(makeStorageLive(s3)))
  );
});
