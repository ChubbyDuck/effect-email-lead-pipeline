import { Duration, Schedule } from 'effect';

/**
 * In ms. The shortest first wait, as in the AWS SDK. A shorter wait gives a service no time to recover, and the jitter
 * is a share of the wait, so a shorter wait also spreads the retries less.
 */
export const minRetryDelay = 100;
/** In ms. The longest wait before a retry, without the jitter. */
export const maxRetryDelay = 2_000;

/**
 * The options of `Effect.retry` for each retry of the pipeline. Each wait doubles from `leadProcessingRetryDelay` up to
 * `maxRetryDelay`, so a service that fails has time to recover. The jitter makes each wait 20% shorter or longer at
 * most, so handlers that fail at the same time do not all retry at the same time.
 */
export const retryPolicy = (config: {
  readonly leadProcessingRetry: number;
  readonly leadProcessingRetryDelay: number;
}) => ({
  times: config.leadProcessingRetry,
  schedule: Schedule.min([
    Schedule.exponential(Duration.millis(config.leadProcessingRetryDelay)),
    Schedule.spaced(Duration.millis(maxRetryDelay)),
  ]).pipe(Schedule.jittered),
});
