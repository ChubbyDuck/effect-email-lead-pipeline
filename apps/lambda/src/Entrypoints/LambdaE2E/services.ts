import { S3Client } from '@aws-sdk/client-s3';
import { makeEmailParserLive } from '@leads/pipeline/infrastructure/EmailParser/live';
import { ExcelSheetParserLive } from '@leads/pipeline/infrastructure/ExcelSheetParser/live';
import { GuardLive } from '@leads/pipeline/infrastructure/Guard/live';
import { makeStorageLive } from '@leads/pipeline/infrastructure/Storage/live';
import { EmailNotParsed, EmailParser } from '@leads/pipeline/ports/EmailParser';
import {
  AuthenticationFailed,
  OrderRepository,
  OrderStoreFailed,
  OrderStoreTimedOut,
} from '@leads/pipeline/ports/OrderRepository';
import { FileNotDeleted, FileNotRead, FileNotStored, Storage } from '@leads/pipeline/ports/Storage';
import { File } from '@leads/shared/domain/types';
import { RequestLedger } from '@leads/shared/ports/RequestLedger';
import { ConfigProvider, Effect, Layer, Logger } from 'effect';
import { simpleParser } from 'mailparser';

import { e2eFlociEndpoint } from './config';
import { hasInvalidConfiguration, instrument, observeLog } from './control';

const s3 = new S3Client({ endpoint: e2eFlociEndpoint, forcePathStyle: true });
const storage = Layer.effect(
  Storage,
  Effect.gen(function* () {
    const live = yield* Storage;
    return {
      ...live,
      read: (bucket, key) =>
        instrument(
          'Storage.read',
          key,
          live.read(bucket, key),
          () => new FileNotRead({ bucket, key, reason: 'injected read failure' })
        ),
      store: (file) =>
        instrument(
          'Storage.store',
          file.key,
          live.store(file),
          () => new FileNotStored({ file, reason: 'injected store failure' })
        ),
      // storeOrSkip uses the fault name of store, so the existing store faults still reach it.
      storeOrSkip: (file) =>
        instrument(
          'Storage.store',
          file.key,
          live.storeOrSkip(file),
          () => new FileNotStored({ file, reason: 'injected store failure' })
        ),
      delete: (bucket, key) =>
        instrument(
          'Storage.delete',
          key,
          live.delete(bucket, key),
          () => new FileNotDeleted({ file: File.make({ bucket, key }), reason: 'injected delete failure' })
        ),
    } satisfies typeof Storage.Service;
  }).pipe(Effect.provide(makeStorageLive(s3)))
);

const parser = Layer.effect(
  EmailParser,
  Effect.gen(function* () {
    const live = yield* EmailParser;
    return {
      parse: (file) =>
        instrument(
          'EmailParser.parse',
          file.key,
          live.parse(file),
          () => new EmailNotParsed({ reason: 'injected parser failure' })
        ),
    } satisfies typeof EmailParser.Service;
  }).pipe(Effect.provide(makeEmailParserLive(simpleParser)))
);

const orders = Layer.succeed(OrderRepository, {
  store: (lead) =>
    instrument('OrderRepository.store', lead.extracted.name ?? '', Effect.void, (fault) =>
      fault.error === 'AuthenticationFailed'
        ? new AuthenticationFailed({ reason: 'injected auth failure' })
        : fault.error === 'OrderStoreTimedOut'
          ? new OrderStoreTimedOut({ reason: 'injected adapter timeout' })
          : new OrderStoreFailed({ reason: 'injected order failure' })
    ),
});

// Floci has no request ledger table yet, so the handlers acknowledge no request and record no progress.
const requestLedger = Layer.succeed(RequestLedger, {
  acknowledge: () => Effect.void,
  record: () => Effect.void,
  changedSince: () => Effect.succeed([]),
  entryOf: () => Effect.undefined,
});

// Log capture observes the actual handler logs; it does not participate in acknowledgement.
const logger = Logger.layer([
  Logger.make((options) => {
    observeLog({ level: options.logLevel, message: options.message });
  }),
]);

// The production services read runtime settings from AppConfig. Floci does not make the stack's AppConfig resources,
// so these services read every setting from the environment.
export const LambdaServicesLive = Layer.mergeAll(
  storage,
  parser,
  ExcelSheetParserLive,
  GuardLive,
  orders,
  requestLedger,
  logger
).pipe(
  Layer.provideMerge(
    ConfigProvider.layer(
      Effect.sync(() =>
        ConfigProvider.fromEnvRecord({
          // A config provider is the one correct reader of the whole environment: the handlers read it through Config.
          // oxlint-disable-next-line effecttsgo/process-env
          ...process.env,
          ...(hasInvalidConfiguration() && { LEAD_PROCESSING_RETRY: 'invalid-number' }),
        })
      )
    )
  )
);
