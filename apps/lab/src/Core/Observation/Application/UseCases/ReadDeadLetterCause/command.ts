import type { CauseQuery } from '#Core/Observation/Domain/dlq';

/** A message of a DLQ, with what links it to the run that failed it. */
export type Command = CauseQuery;
