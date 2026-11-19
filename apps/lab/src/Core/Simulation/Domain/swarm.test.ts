import { describe, expect, it } from 'vitest';

import { inboxTimeline } from './inbox';
import { leadTimeline } from './leads';
import { scheduleSlice, type PoolRun } from './schedule';
import { normalizeSliceInputs, sourceTimeline, type SliceInputs } from './sources';
import { outputOf, swarm, valueAt } from './swarm';
import { sliceDefaults } from './testing/roundDefaults';

const inboxOutput = (input: SliceInputs) => outputOf(inboxTimeline(input));
const sourceOutput = (input: SliceInputs) => outputOf(sourceTimeline(input));
const leadOutput = (input: SliceInputs, leads: number) => outputOf(leadTimeline(input, leads));

/** Latency only: no S3 call takes longer for its bytes, unless a test sets a time per MB. */
const slice = (overrides: Partial<typeof sliceDefaults> = {}) =>
  normalizeSliceInputs({ ...sliceDefaults, in_storage_mb_t: 0, src_storage_mb_t: 0, ...overrides });

describe('Output stretches', () => {
  it('stores sources in full puts after the acknowledgement, the read, the parse, and the count', () => {
    const input = slice({
      S: 120,
      in_c: 50,
      in_storage_read_t: 100,
      in_email_parser_parse_t: 50,
      in_storage_store_t: 30,
    });
    expect(inboxOutput(input)).toEqual([
      { start: 20 + 150 + 20, end: 250, amount: 50, calls: 50, waves: 2 },
      { start: 250, end: 280, amount: 20, calls: 20, waves: 1 },
    ]);
  });

  it('gives the last put wave fewer bytes, so it ends sooner', () => {
    const input = slice({
      S: 120,
      in_c: 50,
      L: 1024,
      row_b: 1024,
      in_storage_read_t: 100,
      in_email_parser_parse_t: 50,
      in_storage_store_t: 30,
      in_storage_mb_t: 2,
    });
    const [full, last] = inboxOutput(input);
    expect(full).toMatchObject({ end: full!.start + 2 * (30 + 50 * 2), amount: 50, waves: 2 });
    expect(last!.end - last!.start).toBe(30 + 20 * 2);
  });

  it('has no stretch when an email holds no source', () => {
    expect(inboxOutput(slice({ S: 0 }))).toEqual([]);
  });

  it('pushes leads in full send waves after the start, the read, the parse, and the leads found', () => {
    const input = slice({
      L: 95,
      src_c: 4,
      src_storage_read_t: 10,
      src_excel_sheet_parser_parse_t: 20,
      src_queue_push_t: 5,
    });
    expect(sourceOutput(input)).toEqual([
      { start: 20 + 30 + 20, end: 80, amount: 40, calls: 4, waves: 2 },
      { start: 80, end: 85, amount: 15, calls: 2, waves: 1 },
    ]);
  });
});

describe('Lead output', () => {
  it('stores leads in full store waves after the parse and the start of the request', () => {
    expect(leadOutput(sliceDefaults, 25)).toEqual([
      { start: 20 + 20, end: 80, amount: 10, calls: 10, waves: 2 },
      { start: 80, end: 100, amount: 5, calls: 5, waves: 1 },
    ]);
    expect(leadOutput(sliceDefaults, 0)).toEqual([]);
  });

  it('reads each wave with the output of its own batch', () => {
    const run: PoolRun = {
      waves: [
        { start: 0, end: 220, count: 2, init: 0, batch: 10 },
        { start: 300, end: 520, count: 1, init: 0, batch: 5 },
      ],
      started: [2, 3],
      taken: [20, 25],
      environments: 2,
      end: 520,
    };
    const body = swarm(run, (wave) => leadOutput(sliceDefaults, wave.batch ?? 1));
    expect(body.output).toBe(25);
    expect(body.inFlight).toEqual([
      { at: 40, value: 20 },
      { at: 60, value: 0 },
      { at: 340, value: 5 },
      { at: 360, value: 0 },
    ]);
  });
});

describe('Swarm', () => {
  const run: PoolRun = {
    waves: [
      { start: 0, end: 100, count: 2, init: 0 },
      { start: 50, end: 170, count: 3, init: 20 },
    ],
    started: [2, 5],
    taken: [2, 5],
    environments: 5,
    end: 170,
  };
  const stretches = [{ start: 10, end: 30, amount: 5, calls: 1, waves: 1 }];

  it('reads the handlers as one body', () => {
    const body = swarm(run, stretches);
    expect(body.start).toBe(0);
    expect(body.end).toBe(170);
    expect(body.handlers).toBe(5);
    expect(body.output).toBe(25);
  });

  it('counts handlers that run at once', () => {
    const body = swarm(run, stretches);
    expect(body.running).toEqual([
      { at: 0, value: 2 },
      { at: 50, value: 5 },
      { at: 100, value: 3 },
      { at: 170, value: 0 },
    ]);
    expect(body.peakRunning).toEqual({ at: 50, value: 5 });
  });

  it('puts the output of a cold wave after its INIT', () => {
    const body = swarm(run, stretches);
    expect(body.inFlight).toEqual([
      { at: 10, value: 10 },
      { at: 30, value: 0 },
      { at: 80, value: 15 },
      { at: 100, value: 0 },
    ]);
    expect(body.peakInFlight).toEqual({ at: 80, value: 15 });
    expect(body.peakCalls).toEqual({ at: 80, value: 3 });
  });

  it('counts the output of a stretch of 0 ms but has nothing in flight', () => {
    const body = swarm(run, [{ start: 10, end: 10, amount: 5, calls: 1, waves: 1 }]);
    expect(body.output).toBe(25);
    expect(body.inFlight).toEqual([]);
    expect(body.peakInFlight).toEqual({ at: 0, value: 0 });
  });

  it('is empty when nothing ran', () => {
    const body = swarm({ waves: [], started: [], taken: [], environments: 0, end: 0 }, stretches);
    expect(body).toMatchObject({ start: 0, end: 0, handlers: 0, output: 0, running: [], inFlight: [] });
  });

  it('releases every source and every lead of the slice', () => {
    const input = slice();
    const schedule = scheduleSlice(input);
    const inbox = swarm(schedule.inbox, inboxOutput(input));
    const sources = swarm(schedule.sources, sourceOutput(input));
    expect(inbox.output).toBe(input.E * input.S);
    expect(sources.output).toBe(input.E * input.S * input.L);
    expect(inbox.peakRunning.value).toBeLessThanOrEqual(input.E_q_c);
    expect(sources.peakRunning.value).toBeLessThanOrEqual(input.S_q_c);
    expect(sources.running.at(-1)).toEqual({ at: schedule.sources.end, value: 0 });
  });
});

describe('Value at a time', () => {
  const steps = [
    { at: 10, value: 4 },
    { at: 30, value: 1 },
  ];

  it('holds a value until the next step', () => {
    expect(valueAt(steps, 0)).toBe(0);
    expect(valueAt(steps, 10)).toBe(4);
    expect(valueAt(steps, 29.9)).toBe(4);
    expect(valueAt(steps, 30)).toBe(1);
    expect(valueAt([], 30)).toBe(0);
  });
});
