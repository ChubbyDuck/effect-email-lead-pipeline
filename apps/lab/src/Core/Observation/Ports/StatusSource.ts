import type { Snapshot } from '#Core/Observation/Domain/snapshot';
import type { WindowHours } from '#Core/Observation/Domain/time';

/** The port that reads a snapshot. */
export interface StatusSource {
  readonly read: (windowHours: WindowHours) => Promise<Snapshot>;
}
