import { Buffer } from 'node:buffer';

import { File } from '@leads/shared/domain/types';
import { definePortMock } from '@leads/shared/testing/variants';
import { Effect } from 'effect';

import {
  FileNotDeleted,
  FileNotRead,
  FileNotStored,
  Storage,
  type StoreOrSkipResult,
} from '#Core/Pipeline/Ports/Storage';

const lead = (name: string) => ({
  extraction_source: 'new_acquisition',
  idempotencyKey: `key-${name}`,
  extracted: { name },
  raw: { Name: name },
});

const fileWith = (bucket: string, key: string, body: string) => File.make({ bucket, key, body: Buffer.from(body) });

const hasLeadNamed = (file: File, name: string) => {
  const leads: unknown = JSON.parse(file.body?.toString() ?? '[]');
  return (
    Array.isArray(leads) && leads.some((lead: { extracted?: { name?: unknown } }) => lead.extracted?.name === name)
  );
};

const storageMock = definePortMock(Storage, ({ method, record, observation }) => {
  const read = record('read');
  const store = record('store');
  const storeOrSkip = record('storeOrSkip');
  const failedOnce = new Set<string>();
  const stored = (file: File) => storeOrSkip(file).pipe(Effect.as<StoreOrSkipResult>('stored'));
  const remove = record('delete');

  return {
    variants: {
      read: method('read', {
        failsWithFileNotRead: (bucket, key) =>
          read(bucket, key).pipe(Effect.andThen(Effect.fail(new FileNotRead({ bucket, key, reason: 'unavailable' })))),
        succeedsWithEmptyBody: (bucket, key) =>
          read(bucket, key).pipe(Effect.andThen(Effect.succeed(fileWith(bucket, key, '')))),
        succeedsWithMalformedJson: (bucket, key) =>
          read(bucket, key).pipe(Effect.andThen(Effect.succeed(fileWith(bucket, key, 'not-json')))),
        succeedsWithoutLeads: (bucket, key) =>
          read(bucket, key).pipe(Effect.andThen(Effect.succeed(fileWith(bucket, key, '[]')))),
        succeedsWithRejectedLead: (bucket, key) =>
          read(bucket, key).pipe(
            Effect.andThen(
              Effect.succeed(fileWith(bucket, key, JSON.stringify([lead('Acme'), { extraction_source: 'unknown' }])))
            )
          ),
        succeedsWithOnlyRejectedLeads: (bucket, key) =>
          read(bucket, key).pipe(
            Effect.andThen(
              Effect.succeed(
                fileWith(
                  bucket,
                  key,
                  JSON.stringify([{ extraction_source: 'unknown' }, { extracted: { name: 'Acme' } }])
                )
              )
            )
          ),
        succeedsWithLeadsNamedInKey: (bucket, key) =>
          read(bucket, key).pipe(
            Effect.andThen(
              Effect.succeed(
                fileWith(bucket, key, JSON.stringify((key.split('/').pop() ?? '').split('+').map((name) => lead(name))))
              )
            )
          ),
        succeedsAfterTwoSeconds: (bucket, key) =>
          read(bucket, key).pipe(
            Effect.andThen(Effect.sleep('2 seconds')),
            Effect.andThen(Effect.succeed(fileWith(bucket, key, JSON.stringify(lead('Acme')))))
          ),
        succeeds: (bucket, key) =>
          read(bucket, key).pipe(Effect.andThen(Effect.succeed(fileWith(bucket, key, JSON.stringify(lead('Acme')))))),
      }),
      storeOrSkip: method('storeOrSkip', {
        failsWithFileNotStored: (file) =>
          storeOrSkip(file).pipe(Effect.andThen(Effect.fail(new FileNotStored({ file, reason: 'unavailable' })))),
        failsWithFileNotStoredForBroken: (file) =>
          file.key.endsWith('-broken')
            ? storeOrSkip(file).pipe(Effect.andThen(Effect.fail(new FileNotStored({ file, reason: 'unavailable' }))))
            : stored(file),
        /** The first store of each key fails. The next store of that key succeeds. */
        failsWithFileNotStoredOnce: (file) =>
          Effect.suspend(() =>
            failedOnce.has(file.key)
              ? stored(file)
              : storeOrSkip(file).pipe(
                  Effect.andThen(Effect.sync(() => failedOnce.add(file.key))),
                  Effect.andThen(Effect.fail(new FileNotStored({ file, reason: 'unavailable' })))
                )
          ),
        skips: (file) => storeOrSkip(file).pipe(Effect.as<StoreOrSkipResult>('skipped')),
        succeeds: stored,
      }),
      store: method('store', {
        failsWithFileNotStored: (file) =>
          store(file).pipe(Effect.andThen(Effect.fail(new FileNotStored({ file, reason: 'unavailable' })))),
        failsWithFileNotStoredForBroken: (file) =>
          store(file).pipe(
            Effect.andThen(
              file.key.endsWith('-broken')
                ? Effect.fail(new FileNotStored({ file, reason: 'unavailable' }))
                : Effect.void
            )
          ),
        failsWithFileNotStoredForBrokenLead: (file) =>
          store(file).pipe(
            Effect.andThen(
              hasLeadNamed(file, 'Broken')
                ? Effect.fail(new FileNotStored({ file, reason: 'unavailable' }))
                : Effect.void
            )
          ),
        succeeds: store,
      }),
      delete: method('delete', {
        failsWithFileNotDeleted: (bucket, key) =>
          remove(bucket, key).pipe(
            Effect.andThen(Effect.fail(new FileNotDeleted({ file: File.make({ bucket, key }), reason: 'unavailable' })))
          ),
        succeeds: remove,
      }),
    },
    observation,
  };
});

export const storageBuilder = storageMock.builder;
export const makeStorage = storageMock.make;
