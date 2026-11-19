/**
 * A comparison summary: many compared requests read together. Each request keeps its own model, because a request sets
 * the shape of its simulation. So the summary compares a request with its own model first, and then takes the median
 * and the mean of those ratios. It works the same for requests with one shape and for requests with many shapes.
 */
import { type Service, services } from '@leads/shared/domain/billing';
import { stageLabels, stageNames } from '@leads/shared/domain/stages';

import type { Charges } from '#Core/Simulation/Domain/charges';
import { type Lane, type LaneName, laneNames } from '#Core/Simulation/Domain/lane';

import { type Comparison, laneStages, type ShapeKey, shapeKeys, type StageStats, statsOf, wholeOf } from './comparison';
import type { RequestCost } from './requestCost';
import type { RequestView } from './requests';
import type { RequestRuns } from './runs';

/** Many values of one measure, read together. */
export interface Spread {
  readonly count: number;
  readonly median: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
}

export function spreadOf(values: readonly number[]): Spread | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median: sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

/** One value of a measure for one request, next to the model of that request. */
export interface MeasureValue {
  readonly requestID: string;
  readonly real: number | undefined;
  readonly model: number | undefined;
  /** How many times the model the real value is. */
  readonly ratio: number | undefined;
  /** False when the summary leaves the request out. The value still shows for its request. */
  readonly counted: boolean;
}

/** One number of the tables, for each request and over the requests that the summary counts. */
export interface Measure {
  readonly values: readonly MeasureValue[];
  readonly real: Spread | undefined;
  readonly model: Spread | undefined;
  readonly ratio: Spread | undefined;
  /** Each request has the same real value and the same model value, so one value says it all. */
  readonly same: boolean;
}

/** One compared request and the simulation of its shape. */
export interface SummaryMember {
  readonly comparison: Comparison;
  readonly cost: RequestCost;
  readonly model: { readonly lanes: Readonly<Record<LaneName, Lane>>; readonly burst: Charges };
  /** Why the summary leaves the request out, from `gapOf`. */
  readonly gap: string | undefined;
}

export const statNames = ['handlers', 'coldStarts', 'firstStart', 'lastEnd', 'meanDuration'] as const;
export type StatName = (typeof statNames)[number];
export type StageMeasures = Readonly<Record<StatName, Measure>>;

export interface ComparisonSummary {
  readonly requests: readonly { readonly requestID: string; readonly gap: string | undefined }[];
  /** The requests in the median and the mean. */
  readonly counted: number;
  /** The different shapes of the counted requests. Each shape has its own model. */
  readonly shapes: number;
  /** The knobs in which those shapes differ. */
  readonly shapeKeys: readonly ShapeKey[];
  /** The counted requests with a cold start. The model of a burst starts cold, so these are the fair comparisons. */
  readonly coldRequests: number;
  /** The lead runs of the counted requests that also took the leads of other requests, each run once. */
  readonly sharedRuns: number;
  readonly stages: Readonly<Record<LaneName, StageMeasures>>;
  readonly whole: StageMeasures;
  readonly cost: {
    readonly stages: Readonly<Record<LaneName, Measure>>;
    readonly total: Measure;
    readonly services: readonly { readonly service: Service; readonly measure: Measure }[];
  };
}

/**
 * Why the numbers of a read are not whole, or undefined when they are. A failed log search and a throttled one look
 * like a request with fewer runs, so such a request must stay out of the median.
 */
export function gapOf({ entry, runs }: { readonly entry: RequestView; readonly runs: RequestRuns }) {
  if (entry.state === 'active') return 'The request is still active.';
  for (const stage of stageNames) {
    const section = runs.stages[stage];
    const label = stageLabels[stage].toLowerCase();
    if (!section.ok) return `The runs of the ${label} stage did not load.`;
    if (section.value.more) return `The logs hold more of the ${label} stage than one read takes.`;
    if (section.value.runs.some((run) => run.durationMs === undefined)) {
      return `A run of the ${label} stage has no REPORT line yet.`;
    }
  }
  return undefined;
}

function ratioOf(real: number | undefined, model: number | undefined) {
  if (real === undefined || model === undefined) return undefined;
  if (model === 0) return real === 0 ? 1 : undefined;
  return real / model;
}

const defined = (values: readonly (number | undefined)[]) => values.filter((value) => value !== undefined);

type Read = (member: SummaryMember) => { readonly real: number | undefined; readonly model: number | undefined };

function measureOf(members: readonly SummaryMember[], read: Read): Measure {
  const values = members.map((member): MeasureValue => {
    const { real, model } = read(member);
    return {
      requestID: member.comparison.requestID,
      real,
      model,
      ratio: ratioOf(real, model),
      counted: member.gap === undefined,
    };
  });
  const counted = values.filter((value) => value.counted);
  const first = values[0];
  return {
    values,
    real: spreadOf(defined(counted.map(({ real }) => real))),
    model: spreadOf(defined(counted.map(({ model }) => model))),
    ratio: spreadOf(defined(counted.map(({ ratio }) => ratio))),
    same: values.every(({ real, model }) => real === first?.real && model === first?.model),
  };
}

const realStats = (member: SummaryMember, lane: LaneName) => statsOf(member.comparison.lanes[lane].pool);
const modelStats = (member: SummaryMember, lane: LaneName) => statsOf(member.model.lanes[lane].pool);

function stageMeasures(members: readonly SummaryMember[], stats: (member: SummaryMember) => [StageStats, StageStats]) {
  const measure = (name: StatName) =>
    measureOf(members, (member) => {
      const [real, model] = stats(member);
      return { real: real[name], model: model[name] };
    });
  return Object.fromEntries(statNames.map((name) => [name, measure(name)])) as unknown as StageMeasures;
}

const stageCost = (member: SummaryMember, lane: LaneName) =>
  member.cost.stages.find(({ stage }) => stage === laneStages[lane])?.cost ?? 0;

const modelCost = (member: SummaryMember, lane: LaneName) =>
  member.model.burst.lines[laneNames.indexOf(lane)]?.applied.value ?? 0;

/** The members keep their order, so that a value can name its request by its place in the list. */
export function summaryOf(members: readonly SummaryMember[]): ComparisonSummary {
  const counted = members.filter(({ gap }) => gap === undefined);
  const sharedRuns = counted.flatMap(({ comparison }) =>
    comparison.loaded
      .filter(({ stage }) => stage === laneStages.leads)
      .flatMap(({ runs }) => runs.filter((run) => run.otherRequests > 0).map(({ runID }) => runID))
  );
  const byLane = <T>(make: (lane: LaneName) => T) =>
    Object.fromEntries(laneNames.map((lane) => [lane, make(lane)])) as Record<LaneName, T>;
  const billed = (service: Service, member: SummaryMember) => ({
    real: member.cost.services[service] ?? 0,
    model: member.model.burst.applied.services[service] ?? 0,
  });
  return {
    requests: members.map(({ comparison, gap }) => ({ requestID: comparison.requestID, gap })),
    counted: counted.length,
    shapes: new Set(counted.map(({ comparison }) => JSON.stringify(comparison.shape))).size,
    shapeKeys: shapeKeys.filter((key) => new Set(counted.map(({ comparison }) => comparison.shape[key])).size > 1),
    coldRequests: counted.filter((member) => laneNames.some((lane) => realStats(member, lane).coldStarts > 0)).length,
    sharedRuns: new Set(sharedRuns).size,
    stages: byLane((lane) => stageMeasures(members, (member) => [realStats(member, lane), modelStats(member, lane)])),
    whole: stageMeasures(members, (member) => [
      wholeOf(laneNames.map((lane) => realStats(member, lane))),
      wholeOf(laneNames.map((lane) => modelStats(member, lane))),
    ]),
    cost: {
      stages: byLane((lane) =>
        measureOf(members, (member) => ({ real: stageCost(member, lane), model: modelCost(member, lane) }))
      ),
      total: measureOf(members, ({ cost, model }) => ({ real: cost.cost, model: model.burst.applied.value })),
      services: services
        .filter((service) =>
          members.some((member) => {
            const { real, model } = billed(service, member);
            return real > 0 || model > 0;
          })
        )
        .map((service) => ({ service, measure: measureOf(members, (member) => billed(service, member)) })),
    },
  };
}
