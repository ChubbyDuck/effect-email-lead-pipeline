import { readRuns } from '#Core/Observation/Application/runs';
import type { ComparisonResult } from '#Core/Observation/Domain/comparison';
import { toView } from '#Core/Observation/Domain/requests';
import { searchWindowOf } from '#Core/Observation/Domain/runs';
import type { LogSearch } from '#Core/Observation/Ports/LogSearch';
import type { RequestEntrySource } from '#Core/Observation/Ports/RequestEntrySource';

export type RequestPorts = {
  readonly entries: RequestEntrySource;
  readonly logs: LogSearch;
};

/**
 * Reads the entry of a request, then its runs in the search window of that entry. This is the only place that picks
 * the window, so a page cannot ask for other times. The ledger deletes an entry one week after its last change, so an
 * older request has no entry and no runs.
 *
 * @param now In ms since the epoch. An active request can run until now.
 */
export async function readRequest(
  { entries, logs }: RequestPorts,
  requestID: string,
  now: number
): Promise<ComparisonResult> {
  const found = await entries.entryOf(requestID);
  if (found === undefined) {
    return {
      ok: false,
      error: `The ledger has no entry for ${requestID}. It deletes an entry one week after its last change.`,
    };
  }
  const entry = toView(found);
  const { from, to } = searchWindowOf(entry, now);
  return { ok: true, entry, runs: await readRuns(logs, { requestID, from, to }, now) };
}
