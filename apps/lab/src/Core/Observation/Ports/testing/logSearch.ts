import type { StageName } from '@leads/shared/domain/stages';

import type { RawLogEvent } from '#Core/Observation/Domain/runs';
import type { LogSearch } from '#Core/Observation/Ports/LogSearch';

export interface LogSearchCall {
  readonly logGroup: string;
  readonly terms: readonly string[];
  readonly from: Date;
  readonly to: Date;
}

const logGroupPrefix = '/aws/lambda/';

export const logGroupOf = (stage: StageName) => `${logGroupPrefix}${stage}`;

/**
 * A log search over fixed events, as CloudWatch Logs does it: a line matches when it contains a term. It keeps each
 * search. Each search of a stage in `failing` fails, and a search gives at most `limit` events.
 */
export function makeLogSearch({
  events = {},
  failing = [],
  timeoutSeconds = 60,
  limit = Number.POSITIVE_INFINITY,
}: {
  readonly events?: Partial<Record<StageName, readonly RawLogEvent[]>>;
  readonly failing?: readonly StageName[];
  readonly timeoutSeconds?: number;
  readonly limit?: number;
}) {
  const searches: LogSearchCall[] = [];
  const logs: LogSearch = {
    deployment: 'production-cdk',
    region: 'eu-north-1',
    handlerOf: async (stage) => ({ logGroup: logGroupOf(stage), timeoutSeconds }),
    search: async (logGroup, terms, from, to) => {
      searches.push({ logGroup, terms, from, to });
      const stage = logGroup.slice(logGroupPrefix.length) as StageName;
      if (failing.includes(stage)) throw new Error('throttled');
      const found = (events[stage] ?? []).filter(
        ({ timestamp, message }) =>
          timestamp >= from.getTime() && timestamp <= to.getTime() && terms.some((term) => message.includes(term))
      );
      return { events: found.slice(0, limit), truncated: found.length > limit };
    },
  };
  return { logs, searches };
}
