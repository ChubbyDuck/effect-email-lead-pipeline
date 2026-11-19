import type { Redriven } from '#Core/Observation/Domain/dlq';
import type { DlqRedrive } from '#Core/Observation/Ports/DlqRedrive';

import type { Command } from './command';

export type Ports = {
  readonly dlqRedrive: DlqRedrive;
};

/**
 * Sends one message of a DLQ back to the main queue of its stage, and deletes it from the DLQ. A failure stays as the
 * port gave it, so a failed delete keeps the original failure in its `reason`.
 */
export const handler = ({ stage, messageId }: Command, { dlqRedrive }: Ports): Promise<Redriven> =>
  dlqRedrive.redrive(stage, messageId);
