import { handlerTimeouts } from './handlerTimeouts';
import type { StageName } from './stages';

/**
 * The settings of the deployed handlers: the stage caps, the batches of the leads stage, the internal concurrency, and
 * the memory. The IaC stack deploys them, and the burst simulator starts from them. The concurrency settings are seeds
 * of the runtime settings. `Simulation/Domain/sources.test.ts` checks them against the simulator defaults. Times in ms,
 * memory in MiB.
 */
export const handlerSettings = {
  /** The most handlers of a stage that run at once: the reserved concurrency and the maximum concurrency of the mapping. */
  stageCaps: { inbox: 50, leadSources: 50, leads: 200 },
  leadBatchSize: 10,
  leadBatchingWindow: 10_000,
  internalConcurrency: { inbox: 50, leadSources: 200, leads: 10 },
  /**
   * Measured for the lead-sources handler: a business-closure workbook of 100,000 rows peaks at about 1,000 MiB RSS.
   * The lead handler keeps the Lambda default. The inbox handler sets no memory, so it gets the default too.
   */
  memorySize: { leadSources: 1536, leads: 128 },
  /** The days that CloudWatch Logs keeps the log of each handler. The lab reads at most the last 24 hours. */
  logRetentionDays: 30,
} as const;

/**
 * The Lambda timeout of the handler of each stage, in ms: `handlerTimeouts` with the stage names as keys. It is here and
 * not in `handlerTimeouts.ts`, because the Lambda bundle includes that file, and a new export there changes the bundle.
 */
export const handlerTimeoutOf: Record<StageName, number> = {
  inbox: handlerTimeouts.inbox,
  leadSources: handlerTimeouts.source,
  leads: handlerTimeouts.lead,
};
