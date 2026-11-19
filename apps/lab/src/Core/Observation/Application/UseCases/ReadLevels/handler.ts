import type { LevelsResult } from '#Core/Observation/Domain/levels';
import type { LevelSource } from '#Core/Observation/Ports/LevelSource';

export type Ports = {
  readonly levels: LevelSource;
};

/** Reads the counts of the queues and the objects of the buckets. */
export async function handler({ levels }: Ports): Promise<LevelsResult> {
  try {
    return { ok: true, levels: await levels.read() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
