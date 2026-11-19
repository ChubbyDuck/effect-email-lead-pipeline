/**
 * The order write limit: the most writes into the orders table in one second. Each execution environment of the lead
 * handler has its own bucket of `environment` writes a second, and the stage cap of the leads stage bounds the
 * environments that run at once. `iac/cdk/src/stack.test.ts` checks that the stage cap times `environment` stays at or below
 * `stack`. A retry is a write too. A new environment starts with a full bucket, so a short peak can pass `stack` a little.
 */
export const orderWritesPerSecond = { stack: 2_000, environment: 10 };
