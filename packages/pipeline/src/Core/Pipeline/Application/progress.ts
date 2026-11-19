import { progressLogMessage, type RequestID, type RequestProgress } from '@leads/shared/domain/request';
import { RequestLedger } from '@leads/shared/ports/RequestLedger';
import { Effect, Ref } from 'effect';

import { AppConfig } from '#Core/Pipeline/Application/config';
import { retryPolicy } from '#Core/Pipeline/Application/retry';

/** The progress writes of one handler. A progress write never changes the result of the handler. */
export const makeProgressRecorder = Effect.gen(function* () {
  const config = yield* AppConfig;
  const ledger = yield* RequestLedger;

  /**
   * Writes one change of a request entry. A write that still fails after its retries is a warning. The log comes
   * first, so it ties the run to the request also when the write fails.
   */
  const record = (requestID: RequestID, progress: RequestProgress) =>
    Effect.logInfo(progressLogMessage(requestID, progress)).pipe(
      Effect.andThen(ledger.record(requestID, progress)),
      Effect.retry(retryPolicy(config)),
      Effect.catch((e) => Effect.logWarning(e)),
      Effect.catchDefect((e) => Effect.logWarning(e))
    );

  return {
    record,
    /**
     * Makes the end of the work of the handler on one request. Only the first end is written, so a failure after the
     * end, such as a defect of the delete, does not count the work a second time.
     */
    makeEnd: (requestID: RequestID) =>
      Ref.make(false).pipe(
        Effect.map(
          (ended) => (progress: RequestProgress) =>
            Ref.getAndSet(ended, true).pipe(
              Effect.andThen((alreadyEnded) => (alreadyEnded ? Effect.void : record(requestID, progress)))
            )
        )
      ),
  };
});
