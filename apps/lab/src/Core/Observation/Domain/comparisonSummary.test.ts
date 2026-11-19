import type { Service } from '@leads/shared/domain/billing';
import type { StageName } from '@leads/shared/domain/stages';
import { describe, expect, test } from 'vitest';

import type { Charges } from '#Core/Simulation/Domain/charges';
import type { Lane, LaneName } from '#Core/Simulation/Domain/lane';
import { poolOf } from '#Core/Simulation/Domain/schedule';

import { requestIDsOf, type Comparison, type RequestShape } from './comparison';
import { gapOf, spreadOf, summaryOf, type SummaryMember } from './comparisonSummary';
import type { RequestCost } from './requestCost';
import type { RequestView } from './requests';
import type { HandlerRun, RequestRuns, StageRuns } from './runs';
import type { Section } from './snapshot';

const laneOf = (start: number, end: number, init = 0) =>
  ({ pool: poolOf([{ start, end, count: 1, init }]) }) as unknown as Lane;

const lanesOf = (end: number, init = 0): Record<LaneName, Lane> => ({
  inbox: laneOf(0, end, init),
  sources: laneOf(end, end * 2, init),
  leads: laneOf(end * 2, end * 3, init),
});

const shape: RequestShape = { E: 1, S: 1, L: 20, row_b: 100 };

interface MemberParts {
  readonly realEnd?: number;
  readonly modelEnd?: number;
  readonly init?: number;
  readonly cost?: number;
  readonly modelCost?: number;
  readonly service?: Service;
  readonly gap?: string;
  readonly shape?: RequestShape;
  readonly sharedRuns?: readonly string[];
}

const member = (requestID: string, parts: MemberParts = {}): SummaryMember => {
  const { realEnd = 1_000, modelEnd = 500, init = 0, cost = 0.003, modelCost = 0.001, service = 'Lambda' } = parts;
  const shared = (parts.sharedRuns ?? []).map((runID) => ({ runID, otherRequests: 1 }) as HandlerRun);
  return {
    comparison: {
      requestID,
      shape: parts.shape ?? shape,
      lanes: lanesOf(realEnd, init),
      loaded: [{ stage: 'leads', runs: [...shared, { runID: `${requestID}-own`, otherRequests: 0 } as HandlerRun] }],
    } as unknown as Comparison,
    cost: {
      stages: [
        { stage: 'inbox', cost: cost / 3 },
        { stage: 'leadSources', cost: cost / 3 },
        { stage: 'leads', cost: cost / 3 },
      ],
      cost,
      services: { [service]: cost },
      unbilledRuns: 0,
    } as unknown as RequestCost,
    model: {
      lanes: lanesOf(modelEnd),
      burst: {
        lines: [{ applied: { value: modelCost } }, { applied: { value: 0 } }, { applied: { value: 0 } }],
        applied: { value: modelCost, services: { [service]: modelCost } },
      } as unknown as Charges,
    },
    gap: parts.gap,
  };
};

describe('requestIDsOf', () => {
  test('splits a pasted text on spaces, new lines, and commas, and keeps the order', () => {
    expect(requestIDsOf(' b, a\n c\t d ')).toEqual(['b', 'a', 'c', 'd']);
  });

  test('keeps each ID once', () => {
    expect(requestIDsOf('a b a')).toEqual(['a', 'b']);
  });

  test('gives nothing for an empty text', () => {
    expect(requestIDsOf(' \n, ')).toEqual([]);
  });
});

describe('spreadOf', () => {
  test('takes the middle value of an odd count', () => {
    expect(spreadOf([9, 1, 5])).toEqual({ count: 3, median: 5, mean: 5, min: 1, max: 9 });
  });

  test('takes the mean of the two middle values of an even count', () => {
    expect(spreadOf([1, 2, 4, 100])).toMatchObject({ median: 3, mean: 26.75 });
  });

  test('has no spread without values', () => {
    expect(spreadOf([])).toBeUndefined();
  });
});

describe('summaryOf', () => {
  test('keeps one value for each request, in the order of the list', () => {
    const summary = summaryOf([member('b', { realEnd: 2_000 }), member('a', { realEnd: 1_000 })]);

    expect(summary.stages.inbox.lastEnd.values.map(({ requestID, real }) => [requestID, real])).toEqual([
      ['b', 2_000],
      ['a', 1_000],
    ]);
  });

  test('takes the median of the real values, so that one long request does not move it', () => {
    const { lastEnd } = summaryOf([
      member('a', { realEnd: 1_000 }),
      member('b', { realEnd: 1_100 }),
      member('c', { realEnd: 40_000 }),
    ]).stages.inbox;

    expect(lastEnd.real).toMatchObject({ median: 1_100, min: 1_000, max: 40_000 });
    expect(lastEnd.real?.mean).toBeCloseTo(14_033.33, 1);
  });

  test('compares each request with the model of its own shape', () => {
    const { lastEnd } = summaryOf([
      member('small', { realEnd: 1_000, modelEnd: 500, shape: { ...shape, L: 20 } }),
      member('big', { realEnd: 8_000, modelEnd: 2_000, shape: { ...shape, L: 200 } }),
    ]).stages.inbox;

    expect(lastEnd.values.map(({ ratio }) => ratio)).toEqual([2, 4]);
    expect(lastEnd.ratio).toMatchObject({ median: 3, mean: 3 });
  });

  test('counts the different shapes', () => {
    const shapes = (L: number) => member('a', { shape: { ...shape, L } });

    expect(summaryOf([shapes(20), shapes(20)]).shapes).toBe(1);
    expect(summaryOf([shapes(20), shapes(200)]).shapes).toBe(2);
  });

  test('names the knobs in which the shapes differ', () => {
    const shapes = (L: number, row_b: number) => member('a', { shape: { ...shape, L, row_b } });

    expect(summaryOf([shapes(20, 100), shapes(20, 100)]).shapeKeys).toEqual([]);
    expect(summaryOf([shapes(20, 100), shapes(20, 101)]).shapeKeys).toEqual(['row_b']);
    expect(summaryOf([shapes(20, 100), shapes(40, 101)]).shapeKeys).toEqual(['L', 'row_b']);
  });

  test('marks a measure as the same when no request differs', () => {
    const summary = summaryOf([member('a'), member('b', { realEnd: 2_000 })]);

    expect(summary.stages.inbox.handlers.same).toBe(true);
    expect(summary.stages.inbox.lastEnd.same).toBe(false);
  });

  test('leaves a request with a gap out of the spread, but keeps its own value', () => {
    const { lastEnd } = summaryOf([
      member('a', { realEnd: 1_000 }),
      member('broken', { realEnd: 5, gap: 'The runs of the leads stage did not load.' }),
    ]).stages.inbox;

    expect(lastEnd.real).toMatchObject({ count: 1, median: 1_000, min: 1_000, max: 1_000 });
    expect(lastEnd.values.map(({ real, counted }) => [real, counted])).toEqual([
      [1_000, true],
      [5, false],
    ]);
  });

  test('has no spread when it counts no request', () => {
    const summary = summaryOf([member('a', { gap: 'The request is still active.' })]);

    expect(summary.counted).toBe(0);
    expect(summary.stages.inbox.lastEnd.real).toBeUndefined();
    expect(summary.stages.inbox.lastEnd.values).toHaveLength(1);
  });

  test('counts the requests with a cold start, and only the counted ones', () => {
    const summary = summaryOf([
      member('warm'),
      member('cold', { init: 300 }),
      member('out', { init: 300, gap: 'The request is still active.' }),
    ]);

    expect(summary.coldRequests).toBe(1);
  });

  test('counts a lead run once when two requests share it', () => {
    const summary = summaryOf([
      member('a', { sharedRuns: ['run-1', 'run-2'] }),
      member('b', { sharedRuns: ['run-1'] }),
    ]);

    expect(summary.sharedRuns).toBe(2);
  });

  test('gives the whole request the first start of the first stage and the last end of all stages', () => {
    const { whole } = summaryOf([member('a', { realEnd: 1_000 })]);

    expect(whole.handlers.values[0]?.real).toBe(3);
    expect(whole.firstStart.values[0]?.real).toBe(0);
    expect(whole.lastEnd.values[0]?.real).toBe(3_000);
    expect(whole.meanDuration.values[0]?.real).toBeUndefined();
  });

  test('sets the cost of each request next to the cost of its model', () => {
    const { cost } = summaryOf([member('a', { cost: 0.003 }), member('b', { cost: 0.005 })]);

    expect(cost.total.real).toMatchObject({ mean: 0.004, min: 0.003, max: 0.005 });
    expect(cost.total.ratio?.mean).toBeCloseTo(4);
    expect(cost.stages.inbox.values.map(({ model }) => model)).toEqual([0.001, 0.001]);
  });

  test('lists only the services that a request or a model pays for', () => {
    const { cost } = summaryOf([member('a', { service: 'Lambda' }), member('b', { service: 'SQS' })]);

    expect(cost.services.map(({ service }) => service)).toEqual(['Lambda', 'SQS']);
  });
});

describe('gapOf', () => {
  const entry = { state: 'done' } as RequestView;
  const stage = (runs: readonly Partial<HandlerRun>[], more = false): Section<StageRuns> => ({
    ok: true,
    value: { logGroup: 'group', runs: runs as readonly HandlerRun[], more },
  });
  const runsOf = (leads: Section<StageRuns>) =>
    ({
      stages: { inbox: stage([]), leadSources: stage([]), leads } satisfies Record<StageName, Section<StageRuns>>,
    }) as RequestRuns;

  test('has no gap when every stage is whole', () => {
    expect(gapOf({ entry, runs: runsOf(stage([{ durationMs: 10 }])) })).toBeUndefined();
  });

  test('names an active request', () => {
    expect(gapOf({ entry: { ...entry, state: 'active' }, runs: runsOf(stage([])) })).toBe(
      'The request is still active.'
    );
  });

  test('names a stage that did not load', () => {
    expect(gapOf({ entry, runs: runsOf({ ok: false, error: 'throttled' }) })).toBe(
      'The runs of the leads stage did not load.'
    );
  });

  test('names a stage with more runs than one read takes', () => {
    expect(gapOf({ entry, runs: runsOf(stage([], true)) })).toBe(
      'The logs hold more of the leads stage than one read takes.'
    );
  });

  test('names a run without a REPORT line', () => {
    expect(gapOf({ entry, runs: runsOf(stage([{}])) })).toBe('A run of the leads stage has no REPORT line yet.');
  });
});
