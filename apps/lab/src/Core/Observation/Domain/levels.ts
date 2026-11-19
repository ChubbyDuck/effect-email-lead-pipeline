/**
 * The levels of the pipeline: the messages in each queue and the objects in each bucket at one time. They change when a
 * message moves through the pipeline, such as after a redrive. A read of the levels costs no CloudWatch metric, so the
 * page can read them often, and put them on the last snapshot.
 */
import type { BucketStatus, QueueStatus, Section, Snapshot } from './snapshot';

export type QueueLevel = Pick<QueueStatus, 'stage' | 'role' | 'visible' | 'inFlight' | 'delayed'>;

export interface Levels {
  readonly readAt: string;
  readonly queues: Section<readonly QueueLevel[]>;
  readonly buckets: Section<readonly BucketStatus[]>;
}

export type LevelsResult =
  | { readonly ok: true; readonly levels: Levels }
  | { readonly ok: false; readonly error: string };

/**
 * The snapshot with the counts of the levels. The metrics of the snapshot stay. A section of the levels that failed
 * keeps the section of the snapshot. Levels that are older than the snapshot change nothing.
 */
export function withLevels(snapshot: Snapshot, levels: Levels): Snapshot {
  if (levels.readAt <= snapshot.collectedAt) return snapshot;
  const { queues, buckets } = snapshot;
  return {
    ...snapshot,
    queues:
      queues.ok && levels.queues.ok
        ? {
            ok: true,
            value: queues.value.map((queue) => {
              const level = (levels.queues.ok ? levels.queues.value : []).find(
                ({ stage, role }) => stage === queue.stage && role === queue.role
              );
              if (level === undefined) return queue;
              return { ...queue, visible: level.visible, inFlight: level.inFlight, delayed: level.delayed };
            }),
          }
        : queues,
    buckets: levels.buckets.ok ? levels.buckets : buckets,
  };
}

/** The counts of the levels in one text, so that two reads compare. */
export function countsOf({ queues, buckets }: Levels): string {
  return JSON.stringify([
    queues.ok
      ? queues.value.map(({ stage, role, visible, inFlight, delayed }) => [stage, role, visible, inFlight, delayed])
      : [],
    buckets.ok ? buckets.value.map(({ stage, objects, truncated }) => [stage, objects.length, truncated]) : [],
  ]);
}

/** True when a main queue has a message, because a handler still has work. */
export const busy = ({ queues }: Levels): boolean =>
  queues.ok &&
  queues.value.some((queue) => queue.role === 'main' && queue.visible + queue.inFlight + queue.delayed > 0);

/** In ms. The page reads the levels this often while it watches the pipeline. */
export const levelPollMs = 2_000;
/**
 * In ms. The page stops when no main queue had a message and no count changed for this long. SQS publishes its counts
 * some seconds late, and a handler deletes its object at the end of its run.
 */
export const quietMs = 20_000;
/** In ms. The page stops after this long in all cases. The longest handler has a timeout of 5 minutes. */
export const watchLimitMs = 10 * 60_000;

export interface Watch {
  readonly startedAt: number;
  /** The last time that a main queue had a message or that a count changed. */
  readonly activeAt: number;
  readonly counts?: string;
}

/** The watch after one read of the levels. A failed read is not activity. */
export function observe(watch: Watch, levels: Levels | undefined, now: number): Watch {
  if (levels === undefined) return watch;
  const counts = countsOf(levels);
  const active = busy(levels) || counts !== watch.counts;
  return { ...watch, counts, activeAt: active ? now : watch.activeAt };
}

export const keepWatching = ({ startedAt, activeAt }: Watch, now: number): boolean =>
  now - startedAt < watchLimitMs && now - activeAt < quietMs;
