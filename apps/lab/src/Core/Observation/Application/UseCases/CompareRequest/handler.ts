import { comparisonOf, loadedOf, shapeOf, type Comparison } from '#Core/Observation/Domain/comparison';
import { requestFactsOf } from '#Core/Observation/Domain/details';
import { requestCostOf, type RequestCost } from '#Core/Observation/Domain/requestCost';
import { normalizeSliceInputs, type SliceInputs } from '#Core/Simulation/Domain/sources';

import type { Command } from './command';

export type ComparedRequest = {
  /** The request sets the shape of the burst. The timing knobs stay as the person set them. */
  readonly knobs: SliceInputs;
  readonly comparison: Comparison;
  /** The real cost of the request, from its runs. */
  readonly cost: RequestCost;
};

/** Puts one loaded request next to the simulation: the knobs that it shapes, its real runs, and its real cost. */
export function handler({ loaded, knobs: own }: Command): ComparedRequest {
  const { shape } = shapeOf(loaded.entry, loadedOf(loaded.runs), own);
  const knobs = normalizeSliceInputs({ ...own, ...shape });
  const comparison = comparisonOf(loaded, knobs);
  const cost = requestCostOf(requestFactsOf(loaded.entry), comparison.loaded);
  return { knobs, comparison, cost };
}
