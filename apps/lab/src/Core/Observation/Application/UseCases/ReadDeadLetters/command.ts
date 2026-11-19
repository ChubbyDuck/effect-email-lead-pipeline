import type { StageName } from '@leads/shared/domain/stages';

/** The stage whose DLQ to read. */
export type Command = {
  readonly stage: StageName;
};
