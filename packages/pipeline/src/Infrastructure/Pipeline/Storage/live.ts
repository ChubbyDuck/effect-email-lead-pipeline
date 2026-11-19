import { Buffer } from 'node:buffer';

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { File } from '@leads/shared/domain/types';
import { nameOf } from '@leads/shared/infrastructure/awsErrors';
import { Effect, Layer } from 'effect';

import {
  FileNotDeleted,
  FileNotRead,
  FileNotStored,
  Storage,
  type StoreOrSkipResult,
} from '#Core/Pipeline/Ports/Storage';

export const makeStorageLive = (s3: S3Client) => {
  const put = (file: File, condition: { readonly IfNoneMatch?: '*' } = {}) =>
    s3.send(
      new PutObjectCommand({ Bucket: file.bucket, Key: file.key, ...condition, ...(file.body && { Body: file.body }) })
    );

  const store = (file: File) =>
    Effect.tryPromise({
      try: () => put(file),
      catch: (reason) => new FileNotStored({ file, reason }),
    }).pipe(Effect.asVoid);

  return Layer.succeed(Storage, {
    store,
    storeSafe: (file) => store(file).pipe(Effect.catch((error) => Effect.logError(error))),
    delete: (bucket, key) =>
      Effect.tryPromise({
        try: () => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
        catch: (reason) => new FileNotDeleted({ file: File.make({ bucket, key }), reason }),
      }).pipe(Effect.asVoid),
    read: (bucket, key) =>
      Effect.tryPromise({
        try: async () => {
          const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          return File.make({
            bucket,
            key,
            body: response.Body === undefined ? undefined : Buffer.from(await response.Body.transformToByteArray()),
          });
        },
        catch: (reason) => new FileNotRead({ bucket, key, reason }),
      }),
    storeOrSkip: (file) =>
      Effect.tryPromise({
        try: () => put(file, { IfNoneMatch: '*' }),
        catch: (reason) => new FileNotStored({ file, reason }),
      }).pipe(
        Effect.as<StoreOrSkipResult>('stored'),
        Effect.catchIf(
          // S3 gives an error code that the SDK does not model, such as `PreconditionFailed`, as the error name.
          ({ reason }) => nameOf(reason) === 'PreconditionFailed',
          () => Effect.succeed<StoreOrSkipResult>('skipped')
        )
      ),
  });
};
