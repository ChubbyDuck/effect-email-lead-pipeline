import { Buffer } from 'node:buffer';

import type { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { File } from '@leads/shared/domain/types';
import { Effect } from 'effect';
import { expect, test, vi } from 'vitest';

import { FileNotStored, Storage } from '#Core/Pipeline/Ports/Storage';

import { makeStorageLive } from './live';

const file = File.make({ bucket: 'lead-sources', key: 'object.txt', body: Buffer.from('body') });

const failure = (name: string) => Object.assign(new Error(name), { name });

function storeOrSkip(send: (command: PutObjectCommand) => Promise<unknown>) {
  const s3 = { send: vi.fn(send) };
  const run = Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage;
      return yield* Effect.result(storage.storeOrSkip(file));
    }).pipe(Effect.provide(makeStorageLive(s3 as unknown as S3Client)))
  );
  return { s3, run };
}

test('storeOrSkip puts the file only when its key is empty', async () => {
  const { s3, run } = storeOrSkip(async () => ({}));

  expect(await run).toMatchObject({ _tag: 'Success', success: 'stored' });
  expect(s3.send.mock.calls[0]![0].input).toMatchObject({
    Bucket: 'lead-sources',
    Key: 'object.txt',
    IfNoneMatch: '*',
  });
});

test('storeOrSkip skips a key that already has a file', async () => {
  const { run } = storeOrSkip(() => Promise.reject(failure('PreconditionFailed')));

  expect(await run).toMatchObject({ _tag: 'Success', success: 'skipped' });
});

test.each(['ConditionalRequestConflict', 'NoSuchBucket', 'AccessDenied'])(
  'storeOrSkip keeps %s unchanged as the reason of FileNotStored',
  async (name) => {
    const reason = failure(name);
    const { run } = storeOrSkip(() => Promise.reject(reason));

    const result = await run;
    expect(result._tag).toBe('Failure');
    if (result._tag !== 'Failure') return;
    expect(result.failure).toBeInstanceOf(FileNotStored);
    expect(result.failure.reason).toBe(reason);
    expect(result.failure.file).toBe(file);
  }
);
