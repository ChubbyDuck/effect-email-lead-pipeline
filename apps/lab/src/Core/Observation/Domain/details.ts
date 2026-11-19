/**
 * The details of one request: what the sheet of a request shows. The server reads the entry, then the runs in the
 * search window of that entry, so the entry, the window, and the cost all come from one read.
 */
import { type StageName, stageNames } from '@leads/shared/domain/stages';

import { type LoadedStage, loadedOf } from './comparison';
import { type Priced, runsPrice } from './costs';
import { type RequestCost, requestCostOf, type RequestFacts } from './requestCost';
import type { RequestView } from './requests';
import type { HandlerRun, RequestRuns } from './runs';

/** What some runs took together. */
export interface RunTally {
  readonly runs: number;
  /** In ms: the sum of the run times. A run without a REPORT line adds nothing. */
  readonly computeMs: number;
  readonly lambda: Priced;
}

export interface RequestDetails {
  /** The entry that the server read. The window and the cost come from it, not from the live feed. */
  readonly entry: RequestView;
  readonly runs: RequestRuns;
  /** The stages that the source read, in the order of the pipeline. */
  readonly loaded: readonly LoadedStage[];
  /** The stages that the source could not read. Their runs are not in the tally or the cost. */
  readonly missing: readonly StageName[];
  readonly tally: RunTally;
  readonly cost: RequestCost;
}

/** The details of a request, or why the read failed. */
export type DetailsResult =
  | { readonly ok: true; readonly details: RequestDetails }
  | { readonly ok: false; readonly error: string };

export const tallyOf = (runs: readonly HandlerRun[]): RunTally => ({
  runs: runs.length,
  computeMs: runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0),
  lambda: runsPrice(runs),
});

/** What the cost of a request needs from its entry. */
export const requestFactsOf = ({ requestID, receivedAt, attachments }: RequestView): RequestFacts => ({
  requestID,
  ...(receivedAt !== undefined && { receivedAt }),
  ...(attachments !== undefined && { attachments }),
});

export function requestDetailsOf(entry: RequestView, runs: RequestRuns): RequestDetails {
  const loaded = loadedOf(runs);
  return {
    entry,
    runs,
    loaded,
    missing: stageNames.filter((stage) => !runs.stages[stage].ok),
    tally: tallyOf(loaded.flatMap((stage) => stage.runs)),
    cost: requestCostOf(requestFactsOf(entry), loaded),
  };
}

/** The live entry changed after the server read the details, so the runs can be out of date. */
export const changedAfterRead = (details: RequestDetails, live: RequestView | undefined) =>
  live !== undefined && Date.parse(live.updatedAt) > Date.parse(details.entry.updatedAt);
