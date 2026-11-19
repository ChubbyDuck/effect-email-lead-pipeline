import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { LambdaClient } from '@aws-sdk/client-lambda';
import type { StageName } from '@leads/shared/domain/stages';

import type { RawLogEvent } from '#Core/Observation/Domain/runs';
import type { HandlerLogs, LogSearch, LogSearchResult } from '#Core/Observation/Ports/LogSearch';

import { type AwsStatusSourceOptions, logGroupOf, readFunctions } from './aws';

/** The most events that the source reads in one filter pattern. */
const searchEventLimit = 5_000;
/** The most characters of one filter pattern. */
const patternLength = 1024;
/**
 * The attempts of one log call. CloudWatch Logs takes 10 FilterLogEvents calls a second for the whole project, and AWS
 * does not change this quota. One search can take many pages, so a list of requests goes over it.
 */
const logAttempts = 10;

/**
 * The filter patterns that together match a line with one of the terms. A pattern has at most 1024 characters, so many
 * terms, such as the IDs of 50 runs, need more than one pattern. A run ID takes 40 characters, as in
 * `?"20b3ae96-eb9e-5c4b-ab2f-cdd1e969bbe4" `.
 */
export function filterPatternsOf(terms: readonly string[]): string[] {
  const groups: string[][] = [];
  let length = 0;
  for (const term of terms) {
    if (term.includes('"')) throw new Error(`A search term cannot have a quote: ${term}`);
    const size = term.length + 4;
    if (size > patternLength) throw new Error(`A search term is too long: ${term}`);
    const group = groups.at(-1);
    if (group === undefined || length + size > patternLength) {
      groups.push([term]);
      length = size;
    } else {
      group.push(term);
      length += size;
    }
  }
  return groups.map((group) => (group.length === 1 ? `"${group[0]}"` : group.map((term) => `?"${term}"`).join(' ')));
}

/** Searches the log groups of the handlers with CloudWatch Logs. It only reads. */
export function makeAwsLogSearch({ name, deployment, endpoint }: AwsStatusSourceOptions): LogSearch {
  const config = { region: deployment.region, ...(endpoint === undefined ? {} : { endpoint }) };
  const lambda = new LambdaClient(config);
  // Adaptive retries slow the client when AWS throttles it, so that a throttled stage still loads.
  const logs = new CloudWatchLogsClient({ ...config, retryMode: 'adaptive', maxAttempts: logAttempts });

  /** A deploy can change a function, but not often, so the handlers are read once. A failure reads them again. */
  let handlers: Promise<Record<StageName, HandlerLogs>> | undefined;
  function handlersOf() {
    handlers ??= readFunctions(lambda, deployment).then(
      (functions) =>
        Object.fromEntries(
          functions.map((handler) => [
            handler.stage,
            { logGroup: logGroupOf(handler), timeoutSeconds: handler.configuration.Timeout ?? 900 },
          ])
        ) as Record<StageName, HandlerLogs>
    );
    handlers.catch(() => (handlers = undefined));
    return handlers;
  }

  async function filter(logGroupName: string, filterPattern: string, from: Date, to: Date): Promise<LogSearchResult> {
    const events: RawLogEvent[] = [];
    let token: string | undefined;
    do {
      const page = await logs.send(
        new FilterLogEventsCommand({
          logGroupName,
          filterPattern,
          startTime: from.getTime(),
          endTime: to.getTime(),
          ...(token === undefined ? {} : { nextToken: token }),
        })
      );
      for (const event of page.events ?? []) {
        events.push({
          timestamp: event.timestamp ?? 0,
          message: event.message ?? '',
          logStream: event.logStreamName ?? '',
        });
      }
      token = page.nextToken;
    } while (token !== undefined && events.length < searchEventLimit);
    return { events, truncated: token !== undefined };
  }

  return {
    deployment: name,
    region: deployment.region,
    handlerOf: async (stage) => (await handlersOf())[stage],
    async search(logGroup, terms, from, to) {
      const read = await Promise.all(filterPatternsOf(terms).map((pattern) => filter(logGroup, pattern, from, to)));
      return { events: read.flatMap(({ events }) => events), truncated: read.some(({ truncated }) => truncated) };
    },
  };
}
