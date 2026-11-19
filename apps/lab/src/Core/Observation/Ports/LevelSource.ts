import type { Levels } from '#Core/Observation/Domain/levels';

/** The port that reads the levels. It only reads. */
export interface LevelSource {
  readonly read: () => Promise<Levels>;
}
