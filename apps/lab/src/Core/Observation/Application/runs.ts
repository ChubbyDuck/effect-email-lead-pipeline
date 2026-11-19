import { stageNames, type StageName } from '@leads/shared/domain/stages';

import { type RequestRuns, type RunQuery, runIDOf, type StageRuns, toRuns } from '#Core/Observation/Domain/runs';
import { section } from '#Core/Observation/Domain/snapshot';
import type { LogSearch } from '#Core/Observation/Ports/LogSearch';

/** The most runs of one stage that a search reads. A lead handler can take a request in many runs. */
export const runLimit = 50;

export interface RunSearch {
  readonly stage: StageName;
  readonly logGroup: string;
  /** A run matches when one of its lines contains one of the terms. */
  readonly terms: readonly string[];
  /** The request that the runs belong to. A run that changed other requests counts them. */
  readonly requestID: string;
  readonly from: Date;
  readonly to: Date;
}

/**
 * The runs with a line that contains a term, with all their lines. Lambda puts the ID of the run on each line, so a
 * search for the terms finds some lines, and a second search for the IDs of their runs finds every line of those runs.
 */
export async function runsMatching(
  logs: LogSearch,
  { stage, logGroup, terms, requestID, from, to }: RunSearch
): Promise<StageRuns> {
  const found = await logs.search(logGroup, terms, from, to);
  const runIDs = [
    ...new Set(found.events.toSorted((a, b) => a.timestamp - b.timestamp).map(({ message }) => runIDOf(message))),
  ].filter((runID) => runID !== undefined);
  const read =
    runIDs.length === 0
      ? { events: [], truncated: false }
      : await logs.search(logGroup, runIDs.slice(0, runLimit), from, to);
  return {
    logGroup,
    runs: toRuns(stage, requestID, read.events),
    more: found.truncated || runIDs.length > runLimit || read.truncated,
  };
}

/**
 * The runs of a request in each stage. The handlers log each progress write with the request ID, so the runs of the
 * request have a line with it. A stage that the logs cannot give holds its error, and the other stages still load.
 *
 * @param now In ms since the epoch. The time of the read.
 */
export async function readRuns(logs: LogSearch, { requestID, from, to }: RunQuery, now: number): Promise<RequestRuns> {
  const sections = await Promise.all(
    stageNames.map((stage) =>
      section(async () =>
        runsMatching(logs, {
          stage,
          logGroup: (await logs.handlerOf(stage)).logGroup,
          terms: [requestID],
          requestID,
          from,
          to,
        })
      )
    )
  );
  return {
    requestID,
    deployment: logs.deployment,
    region: logs.region,
    from: from.toISOString(),
    to: to.toISOString(),
    readAt: new Date(now).toISOString(),
    stages: Object.fromEntries(stageNames.map((stage, index) => [stage, sections[index]!])) as RequestRuns['stages'],
  };
}
