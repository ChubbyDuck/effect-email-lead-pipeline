import type { StageName } from '@leads/shared/domain/stages';

/** The message to send back to the main queue of its stage. */
export type Command = {
  readonly stage: StageName;
  readonly messageId: string;
};
