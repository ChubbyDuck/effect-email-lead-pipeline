import type { StageName } from '@leads/shared/domain/stages';

import type { DlqMessages } from '#Core/Observation/Domain/dlq';

/** The port that reads the messages of a DLQ. It must not delete a message or hide it from the queue. */
export interface DlqSource {
  readonly peek: (stage: StageName) => Promise<DlqMessages>;
}
