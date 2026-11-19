import type { StageName } from '@leads/shared/domain/stages';

import type { RawLogEvent } from '#Core/Observation/Domain/runs';

/** The logs of the handler of one stage. */
export interface HandlerLogs {
  readonly logGroup: string;
  /** In seconds. A run ends at the latest this long after it starts. */
  readonly timeoutSeconds: number;
}

export interface LogSearchResult {
  /** In any order. */
  readonly events: readonly RawLogEvent[];
  /** True when the logs have more events that match than `events`. */
  readonly truncated: boolean;
}

/** The port that searches the log lines of the handlers. It only reads. */
export interface LogSearch {
  /** The environment and the region of the logs. */
  readonly deployment: string;
  readonly region: string;
  readonly handlerOf: (stage: StageName) => Promise<HandlerLogs>;
  /** The lines of a log group from `from` to `to` that contain one of the terms or more. The case of a term matters. */
  readonly search: (logGroup: string, terms: readonly string[], from: Date, to: Date) => Promise<LogSearchResult>;
}
