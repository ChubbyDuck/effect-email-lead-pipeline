import type { RequestView } from '#Core/Observation/Domain/requests';
import type { RequestRuns } from '#Core/Observation/Domain/runs';
import type { SliceInputs } from '#Core/Simulation/Domain/sources';

/** The entry and the runs of one request, as the read of a comparison gives them. */
export type LoadedComparison = {
  readonly entry: RequestView;
  readonly runs: RequestRuns;
};

/** A loaded request and the knobs of the person. */
export type Command = {
  readonly loaded: LoadedComparison;
  readonly knobs: SliceInputs;
};
