import type { DlqMessages } from '#Core/Observation/Domain/dlq';
import type { DlqSource } from '#Core/Observation/Ports/DlqSource';

import type { Command } from './command';

export type Ports = {
  readonly dlq: DlqSource;
};

/** Reads the messages of the DLQ of one stage. Each message stays in its DLQ. */
export const handler = ({ stage }: Command, { dlq }: Ports): Promise<DlqMessages> => dlq.peek(stage);
