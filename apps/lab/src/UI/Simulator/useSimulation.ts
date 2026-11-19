import { useMemo } from 'react';

import type { LoadedComparison } from '#Core/Observation/Application/UseCases/CompareRequest/command';
import { handler as compareRequest } from '#Core/Observation/Application/UseCases/CompareRequest/handler';
import type { RequestRead } from '#Core/Observation/Domain/comparison';
import { gapOf, summaryOf } from '#Core/Observation/Domain/comparisonSummary';
import { handler as simulateBurst, type Simulation } from '#Core/Simulation/Application/UseCases/SimulateBurst/handler';
import { laneNames } from '#Core/Simulation/Domain/lane';
import type { SliceInputs } from '#Core/Simulation/Domain/sources';

/**
 * The driving adapter of the burst simulator. A loaded request first sets the shape of the knobs, then the simulation
 * runs on the merged knobs. The horizon covers the simulation and the real runs.
 */
export function useSimulation(knobs: SliceInputs, loaded: LoadedComparison | undefined) {
  const compared = useMemo(() => (loaded === undefined ? null : compareRequest({ loaded, knobs })), [loaded, knobs]);
  const simulation = useMemo(() => simulateBurst({ knobs: compared?.knobs ?? knobs }), [compared, knobs]);
  const real = compared?.comparison.lanes;
  const horizon = Math.max(simulation.horizon, ...laneNames.map((lane) => real?.[lane].pool.end ?? 0));
  return { simulation, compared, horizon };
}

/**
 * The driving adapter of the comparison summary. It compares each request, and simulates each shape once, as many
 * requests can share a shape and a change of a knob runs all of this again. It needs two requests to read together.
 */
export function useSummary(knobs: SliceInputs, reads: readonly RequestRead[]) {
  return useMemo(() => {
    const loaded = reads.flatMap(({ result }) => (result.ok ? [result] : []));
    if (loaded.length < 2) return null;
    const models = new Map<string, Simulation>();
    return summaryOf(
      loaded.map((read) => {
        const compared = compareRequest({ loaded: read, knobs });
        const shape = JSON.stringify(compared.comparison.shape);
        const model = models.get(shape) ?? simulateBurst({ knobs: compared.knobs });
        models.set(shape, model);
        return {
          comparison: compared.comparison,
          cost: compared.cost,
          model: { lanes: model.lanes, burst: model.charges.burst },
          gap: gapOf(read),
        };
      })
    );
  }, [reads, knobs]);
}
