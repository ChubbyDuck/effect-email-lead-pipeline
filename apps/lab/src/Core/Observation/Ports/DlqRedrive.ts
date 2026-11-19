import type { StageName } from '@leads/shared/domain/stages';
import { withReason } from '@leads/shared/utils';

import type { Redriven } from '#Core/Observation/Domain/dlq';

export class MessageNotInDlq extends Error {
  constructor(
    readonly messageId: string,
    readonly queueName: string
  ) {
    super(`Message ${messageId} is not in ${queueName}. Another redrive or the retention can have removed it.`);
  }
}

/** The redrive sent the message to its queue, but could not delete it from the DLQ. The handler can get it two times. */
export class RedriveNotDeleted extends Error {
  constructor(
    readonly messageId: string,
    readonly reason: unknown
  ) {
    super(withReason(`Message ${messageId} went back to its queue, but a copy stays in the DLQ`, reason));
  }
}

/**
 * The port that sends one message of a DLQ back to the main queue of its stage, and deletes it from the DLQ. Unlike
 * the other ports of the lab, it changes state. The handler of the stage then takes the message again.
 */
export interface DlqRedrive {
  readonly redrive: (stage: StageName, messageId: string) => Promise<Redriven>;
}
