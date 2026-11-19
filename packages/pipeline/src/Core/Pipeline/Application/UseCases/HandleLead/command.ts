import type { QueueRecord } from '#Core/Pipeline/Domain/Transformations/leads';

export type Command = {
  /** Each record carries the request ID of its lead in its body. */
  readonly records: readonly QueueRecord[];
  readonly functionName: string;
  readonly source: string;
};
