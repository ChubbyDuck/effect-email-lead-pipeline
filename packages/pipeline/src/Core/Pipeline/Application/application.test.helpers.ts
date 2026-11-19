import { makeRequestLedger, requestLedgerBuilder } from '@leads/shared/infrastructure/RequestLedger/mock/variants';
import type { RequestLedger } from '@leads/shared/ports/RequestLedger';
import { ConfigProvider, Effect, Layer, Logger } from 'effect';
import { TestClock } from 'effect/testing';

import type { Storage } from '#Core/Pipeline/Ports/Storage';
import { makeStorage, storageBuilder } from '#Infrastructure/Pipeline/Storage/mock/variants';

import { exitOnTestClock } from './UseCases/testing/clock';

type LoggedEvent = { readonly logLevel: string; readonly message: unknown };

/**
 * Runs an effect of the application layer on the mock Storage and RequestLedger, with three retries.
 * Storage.delete and RequestLedger.record succeed unless a case selects otherwise.
 */
export async function runWithPorts<A, E>(
  effect: Effect.Effect<A, E, Storage | RequestLedger>,
  setup: { readonly storage?: typeof storageBuilder; readonly requestLedger?: typeof requestLedgerBuilder } = {}
) {
  const storage = makeStorage(setup.storage ?? storageBuilder.delete('succeeds'));
  const requestLedger = makeRequestLedger(setup.requestLedger ?? requestLedgerBuilder.record('succeeds'));
  const logged: LoggedEvent[] = [];
  const exit = await Effect.runPromise(
    exitOnTestClock(effect).pipe(
      Effect.provide(
        Layer.mergeAll(
          storage.layer,
          requestLedger.layer,
          TestClock.layer(),
          Logger.layer([Logger.make(({ logLevel, message }) => logged.push({ logLevel, message }))]),
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ LEAD_SOURCES_BUCKET_NAME: 'lead-sources', LEAD_PROCESSING_RETRY: 3 })
          )
        )
      )
    )
  );
  const loggedAt = (logLevel: string) =>
    logged.flatMap((entry) =>
      entry.logLevel === logLevel ? (Array.isArray(entry.message) ? entry.message : [entry.message]) : []
    );
  return {
    exit,
    storage: storage.observation,
    requestLedger: requestLedger.observation,
    loggedInfos: () => loggedAt('Info'),
    loggedWarnings: () => loggedAt('Warn'),
    loggedErrors: () => loggedAt('Error'),
  };
}
