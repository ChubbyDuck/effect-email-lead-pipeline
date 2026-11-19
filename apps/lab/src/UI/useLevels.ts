import { useEffect, useState } from 'react';

import {
  keepWatching,
  levelPollMs,
  type Levels,
  type LevelsResult,
  observe,
  type Watch,
} from '#Core/Observation/Domain/levels';

/** Reads the levels through the server. */
export type LevelsReader = () => Promise<LevelsResult>;

/**
 * The levels of the pipeline while the page watches it. A call of `watch`, such as after a redrive, starts the polls,
 * or starts them again. The polls stop when the pipeline is quiet, so that a page left open sends no requests.
 */
export function useLevels(read: LevelsReader) {
  const [levels, setLevels] = useState<Levels>();
  const [startedAt, setStartedAt] = useState<number>();

  useEffect(() => {
    if (startedAt === undefined) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watch: Watch = { startedAt, activeAt: startedAt };
    const poll = async () => {
      const result = await read().catch(() => undefined);
      if (stopped) return;
      if (result?.ok === true) setLevels(result.levels);
      const now = Date.now();
      watch = observe(watch, result?.ok === true ? result.levels : undefined, now);
      if (keepWatching(watch, now)) timer = setTimeout(() => void poll(), levelPollMs);
      else setStartedAt(undefined);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [startedAt, read]);

  return { levels, watching: startedAt !== undefined, watch: () => setStartedAt(Date.now()) };
}
