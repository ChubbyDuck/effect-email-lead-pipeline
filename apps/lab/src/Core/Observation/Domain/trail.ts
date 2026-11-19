/**
 * The trail of a request: what its runs say about it. A handler logs each change of the request entry and the size of
 * each file that it reads, with the request ID. A lead run takes the leads of many requests, so a run can also have
 * lines of other requests.
 *
 * A retry reads the same file again, so a file counts once: one for each key, with its largest size.
 */
import { type FileSize, fileSizeOfLogMessage, type RequestProgress } from '@leads/shared/domain/request';

import { type HandlerRun, parseLine } from './runs';

/** One change of the request entry, at its time in ms since the epoch. */
export interface TimedChange {
  readonly at: number;
  readonly change: RequestProgress;
}

/** The size of one file of the request that a run read, at its time in ms since the epoch. */
export interface FileRead {
  readonly at: number;
  readonly size: FileSize;
}

/** What one run did for one request. */
export interface RunTrail {
  /** Oldest first. */
  readonly changes: readonly TimedChange[];
  /** Oldest first. */
  readonly reads: readonly FileRead[];
  /** The attachments that an inbox run counted. None when the run did not count them. */
  readonly attachments?: number;
  /** The leads that a source run found. */
  readonly leadsFound: number;
  /** The leads that a lead run took. */
  readonly leadsTaken: number;
  /**
   * The share of the run that the request pays. A lead run takes the leads of many requests in one batch, so the
   * request pays its leads over all the leads of the run. A run of the other stages works on one request only.
   */
  readonly share: number;
}

const sumOf = <T>(items: readonly T[], value: (item: T) => number) =>
  items.reduce((total, item) => total + value(item), 0);

/** A change that moves work from pending to an outcome has a negative pending part, which takes nothing. */
const taken = (change: RequestProgress) => Math.max(0, change.leadsPending ?? 0);

function shareOf(run: HandlerRun, requestID: string, own: number): number {
  if (run.stage !== 'leads') return 1;
  const all = sumOf(run.lines, ({ progress }) => (progress === undefined ? 0 : taken(progress.change)));
  return all > 0 ? own / all : 1;
}

/** The part of one run in one request. */
export function runTrailOf(run: HandlerRun, requestID: string): RunTrail {
  const changes: TimedChange[] = [];
  const reads: FileRead[] = [];
  for (const { time, progress, fileSize } of run.lines) {
    if (progress?.requestID === requestID) changes.push({ at: Date.parse(time), change: progress.change });
    if (fileSize?.requestID === requestID) reads.push({ at: Date.parse(time), size: fileSize.size });
  }
  const counted = changes.flatMap(({ change }) => (change.attachments === undefined ? [] : [change.attachments]));
  const leadsTaken = sumOf(changes, ({ change }) => taken(change));
  return {
    changes,
    reads,
    ...(counted.length > 0 && { attachments: sumOf(counted, (count) => count) }),
    leadsFound: sumOf(changes, ({ change }) => Math.max(0, change.sourcesLeads ?? 0)),
    leadsTaken,
    share: shareOf(run, requestID, leadsTaken),
  };
}

/** One file of a request, and what its runs did with it. */
export interface FileRecord extends FileSize {
  /** The time of the first read. */
  readonly readAt: string;
  /** The end of the last run that read the file, when that run ended. The run deletes the file at its end. */
  readonly endedAt?: string;
  /** The most leads that one run of the file found, so a retry that stopped before its count loses none. */
  readonly leads: number;
}

/** The files of a request that its runs read, one for each key, in the order of the first read. */
export function filesOf(runs: readonly HandlerRun[], requestID: string): FileRecord[] {
  const files = new Map<string, FileRecord>();
  for (const run of runs.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const trail = runTrailOf(run, requestID);
    for (const { at, size } of trail.reads) {
      const known = files.get(size.key);
      files.set(size.key, {
        kind: size.kind,
        key: size.key,
        bytes: Math.max(size.bytes, known?.bytes ?? 0),
        readAt: known?.readAt ?? new Date(at).toISOString(),
        ...(run.outcome === 'ended' && run.endedAt !== undefined
          ? { endedAt: run.endedAt }
          : known?.endedAt !== undefined && { endedAt: known.endedAt }),
        leads: Math.max(trail.leadsFound, known?.leads ?? 0),
      });
    }
  }
  return [...files.values()];
}

/** The bytes of each email in raw Lambda log lines of many requests, one for each key. */
export function emailBytesOf(raws: readonly string[]): number[] {
  const bytes = new Map<string, number>();
  for (const raw of raws) {
    const size = fileSizeOfLogMessage(parseLine(raw).message)?.size;
    if (size?.kind === 'email') bytes.set(size.key, Math.max(size.bytes, bytes.get(size.key) ?? 0));
  }
  return [...bytes.values()];
}
