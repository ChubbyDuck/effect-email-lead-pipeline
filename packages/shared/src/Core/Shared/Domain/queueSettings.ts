import { handlerSettings } from './handlerSettings';
import type { StageName } from './stages';

/** 14 days in ms: the longest retention that SQS permits. */
const maxRetention = 14 * 24 * 60 * 60 * 1000;

/**
 * The settings of the queues of the stack and of their event source mappings. Times in ms. The caps, the batch size,
 * and the batching window of the leads stage come from `handlerSettings`, so each number has one place.
 */
export const queueSettings = {
  /**
   * The event source mapping of each stage: the messages of one invocation, the batching window, and the most handlers
   * at once. A window of 0 is the AWS default: the mapping does not wait to fill a batch.
   */
  mapping: {
    inbox: { batchSize: 1, batchingWindow: 0, maxConcurrency: handlerSettings.stageCaps.inbox },
    leadSources: { batchSize: 1, batchingWindow: 0, maxConcurrency: handlerSettings.stageCaps.leadSources },
    leads: {
      batchSize: handlerSettings.leadBatchSize,
      batchingWindow: handlerSettings.leadBatchingWindow,
      maxConcurrency: handlerSettings.stageCaps.leads,
    },
  } satisfies Record<StageName, { batchSize: number; batchingWindow: number; maxConcurrency: number }>,
  /** The retention of a stage queue. A stage without a value keeps the SQS default of four days. */
  retention: { leads: maxRetention } satisfies Partial<Record<StageName, number>>,
  /** The retention of each dead-letter queue. */
  deadLetterRetention: maxRetention,
  /** A message goes to the dead-letter queue after its first failed receive. */
  maxReceiveCount: 1,
} as const;

/**
 * The visibility timeout of a queue in ms: the batching window, one invocation (the timeout of the handler), and a
 * margin of 30 s. AWS advises six times the function timeout, so that a throttled batch can wait for a retry. Here the
 * reserved concurrency of each handler matches the maximum concurrency of its mapping, so the mapping does not throttle
 * it. A handler releases a failed message at once (`releaseFailedRecords`), so only a crash or a timeout waits this long.
 */
export const visibilityTimeout = (timeout: number, batchingWindow = 0): number => batchingWindow + timeout + 30_000;
