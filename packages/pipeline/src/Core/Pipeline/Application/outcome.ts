import type { Outcome, RequestID, RequestProgress } from '@leads/shared/domain/request';
import { Effect } from 'effect';

import { AppConfig } from '#Core/Pipeline/Application/config';
import { makeProgressRecorder } from '#Core/Pipeline/Application/progress';
import { retryPolicy } from '#Core/Pipeline/Application/retry';
import { Storage } from '#Core/Pipeline/Ports/Storage';

/**
 * The handler outcome: how a handler ends its work on the file of one request.
 *
 * - Work that succeeds is processed.
 * - A failure in `rejections` is rejected: a redrive cannot fix the file. The failure is logged as an error.
 * - The ledger keeps the status, so a processed or rejected file has no more use and is deleted. A delete that still
 *   fails after its retries is a warning, and the handler succeeds.
 * - Every other failure, and every defect, is failed: it becomes `notHandled(reason)`, which is logged as an error,
 *   because the DLQ message does not carry the reason. The file stays, so a redrive can retry it.
 * - An interruption is not an outcome. It writes no end, and it is not logged or wrapped.
 *
 * The end of each outcome is written as soon as it is known, and only the first end is written. So a defect of the
 * delete fails the handler, but it does not change the end of the work.
 */
export const withHandlerOutcome = <E extends { readonly _tag: string }, R, F>(
  work: Effect.Effect<void, E, R>,
  options: {
    readonly requestID: RequestID;
    /** The file the handler works on. */
    readonly file: { readonly bucket: string; readonly key: string };
    readonly rejections: readonly E['_tag'][];
    /** The end of the request for an outcome. `reason` is the failure or the defect of a failed handler. */
    readonly ended: (outcome: Outcome, reason?: unknown) => RequestProgress;
    readonly notHandled: (reason: unknown) => F;
  }
) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const storage = yield* Storage;
    const progress = yield* makeProgressRecorder;
    const end = yield* progress.makeEnd(options.requestID);
    const fail = (reason: unknown) =>
      Effect.fail(options.notHandled(reason)).pipe(
        Effect.tapError((error) => Effect.logError(error)),
        Effect.tapError(() => end(options.ended('failed', reason)))
      );

    return yield* work.pipe(
      Effect.andThen(() => end(options.ended('processed'))),
      Effect.catchIf(
        (e) => options.rejections.includes(e._tag),
        (e) => Effect.logError(e).pipe(Effect.andThen(() => end(options.ended('rejected'))))
      ),
      Effect.andThen(() =>
        storage.delete(options.file.bucket, options.file.key).pipe(
          Effect.retry(retryPolicy(config)),
          Effect.catch((e) => Effect.logWarning(e))
        )
      ),
      Effect.catch(fail),
      Effect.catchDefect(fail)
    );
  });
