/**
 * The Lambda runs of one request, as the logs show them. A handler logs each progress write with the request ID, and
 * Lambda puts the ID of the run on each log line. A search for the request ID in the logs so finds the runs, and a
 * search for the IDs of the runs finds all their lines.
 */
import {
  type FileSize,
  fileSizeOfLogMessage,
  progressOfLogMessage,
  type RequestProgress,
} from '@leads/shared/domain/request';
import type { StageName } from '@leads/shared/domain/stages';

import type { Section } from './snapshot';

/** One event of CloudWatch Logs. */
export interface RawLogEvent {
  readonly timestamp: number;
  readonly message: string;
  readonly logStream: string;
}

/** `platform` is a line of the Lambda service: `START`, `END`, or `REPORT`. */
export type LineLevel = 'error' | 'warn' | 'info' | 'debug' | 'platform';

export interface RunLine {
  readonly time: string;
  readonly level: LineLevel;
  readonly message: string;
  /** The change of a progress write, and the request that it changed. */
  readonly progress?: { readonly requestID: string; readonly change: RequestProgress };
  /** The size of a file that the run read, and the request of the file. */
  readonly fileSize?: { readonly requestID: string; readonly size: FileSize };
}

/**
 * How a run ended. A run without a `REPORT` line still runs, or it ended after the time of the search. A failed run
 * threw out of the handler; the errors that the handler logs and handles do not fail the run.
 */
export type RunOutcome = 'running' | 'ended' | 'failed' | 'timeout';

export interface HandlerRun {
  readonly stage: StageName;
  /** The ID that Lambda gives the run. */
  readonly runID: string;
  readonly logStream: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly outcome: RunOutcome;
  /** In ms. */
  readonly durationMs?: number;
  /** In ms. */
  readonly billedMs?: number;
  /** In ms. Only a cold start has it. */
  readonly initMs?: number;
  readonly memoryMb?: number;
  readonly maxMemoryMb?: number;
  readonly errors: number;
  readonly warnings: number;
  /** The requests other than this one that the run changed. A lead handler takes the leads of many requests. */
  readonly otherRequests: number;
  /** The bytes of all the log lines of the run, also the lines after `runLineLimit`. CloudWatch Logs bills them. */
  readonly logBytes: number;
  /** Oldest first. At most `runLineLimit`. */
  readonly lines: readonly RunLine[];
  /** True when the run has more lines than `lines`. */
  readonly truncated: boolean;
}

export interface StageRuns {
  readonly logGroup: string;
  /** Oldest first. */
  readonly runs: readonly HandlerRun[];
  /** True when the logs have more runs or lines of this stage than the source read. */
  readonly more: boolean;
}

export interface RequestRuns {
  readonly requestID: string;
  readonly deployment: string;
  readonly region: string;
  /** The time that the search covered. */
  readonly from: string;
  readonly to: string;
  readonly readAt: string;
  readonly stages: Readonly<Record<StageName, Section<StageRuns>>>;
}

export interface RunQuery {
  readonly requestID: string;
  readonly from: Date;
  readonly to: Date;
}

/** The most lines of one run that a run keeps. */
export const runLineLimit = 400;

/** In ms. A run writes its last lines after the last change of the entry, such as the delete of its file. */
const searchMarginMs = 2 * 60_000;
/** In ms. A source without an email has no receive time, so the search starts this long before its last change. */
const standaloneLookbackMs = 60 * 60_000;
/** In ms. The ledger keeps an entry one week after its last change, so no request is older. */
export const longestSearchMs = 8 * 24 * 3_600_000;

/**
 * The time in which the runs of a request write their lines. A request that is still active can run until now. Each
 * search costs log requests, so the window is never longer than `longestSearchMs`: it keeps the end of the request.
 */
export function searchWindowOf(
  request: { readonly receivedAt?: string; readonly updatedAt: string; readonly state: string },
  now: number
): { readonly from: Date; readonly to: Date } {
  const updated = Date.parse(request.updatedAt);
  const start = request.receivedAt === undefined ? updated - standaloneLookbackMs : Date.parse(request.receivedAt);
  const end = request.state === 'active' ? now : Math.min(now, updated + searchMarginMs);
  const to = Math.max(end, start);
  return { from: new Date(Math.max(start - searchMarginMs, to - longestSearchMs)), to: new Date(to) };
}

/**
 * A Lambda log line of the code: `<time>\t<run ID>\t<level>\t<message>`. A line of the INIT phase, such as an error
 * when the module loads, has `undefined` in place of the run ID.
 */
const codeLine = /^\S+\t([0-9a-f-]{36}|undefined)\t(\w+)\t([\s\S]*)$/;
/** A line of the Lambda service with the ID of the run. */
const platformLine = /^(START|END|REPORT) RequestId: ([0-9a-f-]{36})/;
/** The line of the runtime when the run times out. It has spaces, not tabs. */
const timeoutLine = /^\S+ ([0-9a-f-]{36}) (Task timed out[\s\S]*)$/;
/** An Effect log line: `[<time>] <LEVEL> (#<fiber>)<spans>: <message>`. */
const effectLine = /^\[[\d:.]+\] ([A-Z]+) \(#\d+\)[^:\n]*:[ \n]?([\s\S]*)$/;

const effectLevels: Partial<Record<string, LineLevel>> = {
  FATAL: 'error',
  ERROR: 'error',
  WARN: 'warn',
  WARNING: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
  TRACE: 'debug',
};

interface ParsedLine {
  readonly runID?: string;
  readonly kind: 'start' | 'end' | 'report' | 'timeout' | 'code';
  readonly level: LineLevel;
  readonly message: string;
  /** True for a line that the runtime writes when the handler throws. */
  readonly runtimeError?: boolean;
}

export function parseLine(raw: string): ParsedLine {
  const text = raw.trimEnd();
  const platform = platformLine.exec(text);
  if (platform?.[1] !== undefined && platform[2] !== undefined) {
    const kind = platform[1] === 'START' ? 'start' : platform[1] === 'END' ? 'end' : 'report';
    return { runID: platform[2], kind, level: 'platform', message: text.replace(/\t+/g, '  ') };
  }
  const timeout = timeoutLine.exec(text);
  if (timeout?.[1] !== undefined && timeout[2] !== undefined) {
    return { runID: timeout[1], kind: 'timeout', level: 'error', message: timeout[2] };
  }
  const code = codeLine.exec(text);
  if (code?.[1] === undefined || code[2] === undefined || code[3] === undefined) {
    return { kind: 'code', level: 'info', message: text };
  }
  const run = code[1] === 'undefined' ? {} : { runID: code[1] };
  const effect = effectLine.exec(code[3]);
  if (effect?.[1] !== undefined && effect[2] !== undefined) {
    return { ...run, kind: 'code', level: effectLevels[effect[1]] ?? 'info', message: effect[2] };
  }
  // The handlers log through Effect to `console.log`, so only the runtime writes a line with the level ERROR.
  const runtimeError = code[2] === 'ERROR';
  const level = runtimeError ? 'error' : code[2] === 'WARN' ? 'warn' : 'info';
  return { ...run, kind: 'code', level, message: code[3], ...(runtimeError && { runtimeError }) };
}

/** The ID of the run that wrote a line. A line of the runtime outside a run, such as `INIT_START`, has none. */
export const runIDOf = (raw: string): string | undefined => parseLine(raw).runID;

/** A value of a raw `REPORT` line, such as `Duration: 447.81 ms`. The fields of the line end with a tab. */
function reportValue(report: string, name: string): number | undefined {
  const match = new RegExp(`\\t${name}: ([\\d.]+)`).exec(report);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

const reportStatus = (report: string) => /\tStatus: (\w+)/.exec(report)?.[1];

const iso = (ms: number) => new Date(ms).toISOString();

const utf8 = new TextEncoder();

/** The runs in the events of one stage, oldest first. The events can come in any order. */
export function toRuns(stage: StageName, requestID: string, events: readonly RawLogEvent[]): HandlerRun[] {
  const byRun = new Map<string, { readonly event: RawLogEvent; readonly line: ParsedLine }[]>();
  for (const event of events.toSorted((a, b) => a.timestamp - b.timestamp)) {
    const line = parseLine(event.message);
    if (line.runID === undefined) continue;
    byRun.set(line.runID, [...(byRun.get(line.runID) ?? []), { event, line }]);
  }

  const runs = [...byRun].map(([runID, entries]): HandlerRun => {
    const report = entries.find(({ line }) => line.kind === 'report');
    const start = entries.find(({ line }) => line.kind === 'start');
    const reportText = report?.event.message ?? '';
    const durationMs = reportValue(reportText, 'Duration');
    const billedMs = reportValue(reportText, 'Billed Duration');
    const initMs = reportValue(reportText, 'Init Duration');
    const memoryMb = reportValue(reportText, 'Memory Size');
    const maxMemoryMb = reportValue(reportText, 'Max Memory Used');
    const status = reportStatus(reportText);
    const startedAt =
      start?.event.timestamp ??
      (report !== undefined && durationMs !== undefined ? report.event.timestamp - durationMs : undefined) ??
      entries[0]!.event.timestamp;
    const end = report ?? entries.find(({ line }) => line.kind === 'end');

    const outcome: RunOutcome =
      status === 'timeout' || entries.some(({ line }) => line.kind === 'timeout')
        ? 'timeout'
        : (status !== undefined && status !== 'success') || entries.some(({ line }) => line.runtimeError === true)
          ? 'failed'
          : end === undefined
            ? 'running'
            : 'ended';

    const lines = entries.map(({ event, line }): RunLine => {
      const progress = line.kind === 'code' ? progressOfLogMessage(line.message) : undefined;
      const fileSize = line.kind === 'code' && progress === undefined ? fileSizeOfLogMessage(line.message) : undefined;
      return {
        time: iso(event.timestamp),
        level: line.level,
        message: line.message,
        ...(progress !== undefined && { progress: { requestID: progress.requestID, change: progress.progress } }),
        ...(fileSize !== undefined && { fileSize }),
      };
    });
    const others = new Set(
      lines.flatMap(({ progress }) =>
        progress === undefined || progress.requestID === requestID ? [] : [progress.requestID]
      )
    );

    return {
      stage,
      runID,
      logStream: entries[0]!.event.logStream,
      startedAt: iso(startedAt),
      ...(end !== undefined && { endedAt: iso(end.event.timestamp) }),
      outcome,
      ...(durationMs !== undefined && { durationMs }),
      ...(billedMs !== undefined && { billedMs }),
      ...(initMs !== undefined && { initMs }),
      ...(memoryMb !== undefined && { memoryMb }),
      ...(maxMemoryMb !== undefined && { maxMemoryMb }),
      errors: lines.filter(({ level }) => level === 'error').length,
      warnings: lines.filter(({ level }) => level === 'warn').length,
      otherRequests: others.size,
      logBytes: entries.reduce((total, { event }) => total + utf8.encode(event.message).length, 0),
      lines: lines.slice(0, runLineLimit),
      truncated: lines.length > runLineLimit,
    };
  });
  return runs.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
}
