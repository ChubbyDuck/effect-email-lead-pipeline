import { describe, expect, it } from 'vitest';

import { inboxDuration, inboxTimeline } from './inbox';
import { leadDuration, leadTokenWait } from './leads';
import {
  concurrencyAt,
  emailsWaiting,
  leadArrivalNear,
  leadsWaiting,
  markLimit,
  marks,
  poolOf,
  runPool,
  scheduleInbox,
  scheduleSlice,
  sourceArrivalNear,
  sourcesReleased,
  sourcesWaiting,
  takenBy,
} from './schedule';
import { normalizeSliceInputs, sourceDuration, sourceTimeline, type SliceInputs } from './sources';
import { sliceDefaults } from './testing/roundDefaults';
import { releasesOf, type Timeline } from './timeline';

/** Every slot open at once and no INIT: the schedule of a mapping that is already scaled and warm. */
const flat = { esm_start: 1000, in_init_t: 0, src_init_t: 0, ld_init_t: 0 };

/** Latency only: no S3 call takes longer for its bytes, unless a test sets a time per MB. */
const slice = (overrides: Partial<typeof sliceDefaults> = {}) =>
  normalizeSliceInputs({ ...sliceDefaults, in_storage_mb_t: 0, src_storage_mb_t: 0, ...overrides });

describe('Event source mapping scale-up', () => {
  it('starts with five invocations and adds one every 200 ms at 300 per minute', () => {
    const scaling = { cap: 50, start: 5, rate: 300 };
    expect(concurrencyAt(scaling, 0)).toBe(5);
    expect(concurrencyAt(scaling, 199)).toBe(5);
    expect(concurrencyAt(scaling, 200)).toBe(6);
    expect(concurrencyAt(scaling, 60_000)).toBe(50);
    expect(concurrencyAt({ cap: 3, start: 5, rate: 300 }, 0)).toBe(3);
    expect(concurrencyAt({ cap: 50, start: 5, rate: 0 }, 60_000)).toBe(5);
  });
});

describe('Handler slots', () => {
  it('runs a burst that fits the cap as one wave', () => {
    const run = runPool([{ at: 25, count: 10 }], { cap: 50, start: 50, rate: 0 }, 520, 0);
    expect(run.waves).toEqual([{ start: 25, end: 545, count: 10, init: 0 }]);
    expect(run.environments).toBe(10);
    expect(run.end).toBe(545);
  });

  it('starts the rest of the burst when the cap frees', () => {
    const run = runPool([{ at: 0, count: 60 }], { cap: 50, start: 50, rate: 0 }, 520, 0);
    expect(run.waves).toEqual([
      { start: 0, end: 520, count: 50, init: 0 },
      { start: 520, end: 1040, count: 10, init: 0 },
    ]);
    expect(run.environments).toBe(50);
  });

  it('takes a message that arrives later into a free slot at once', () => {
    const run = runPool(
      [
        { at: 0, count: 1 },
        { at: 13, count: 1 },
      ],
      { cap: 56, start: 56, rate: 0 },
      1000,
      0
    );
    expect(run.waves).toEqual([
      { start: 0, end: 1000, count: 1, init: 0 },
      { start: 13, end: 1013, count: 1, init: 0 },
    ]);
  });

  it('opens a slot for each step of the scale-up', () => {
    const run = runPool([{ at: 0, count: 8 }], { cap: 50, start: 5, rate: 300 }, 1000, 0);
    expect(run.waves).toEqual([
      { start: 0, end: 1000, count: 5, init: 0 },
      { start: 200, end: 1200, count: 1, init: 0 },
      { start: 400, end: 1400, count: 1, init: 0 },
      { start: 600, end: 1600, count: 1, init: 0 },
    ]);
  });

  it('runs INIT on each new environment and reuses a warm one with no INIT', () => {
    const run = runPool([{ at: 0, count: 3 }], { cap: 2, start: 2, rate: 0 }, 100, 50);
    expect(run.waves).toEqual([
      { start: 0, end: 150, count: 2, init: 50 },
      { start: 150, end: 250, count: 1, init: 0 },
    ]);
    expect(run.environments).toBe(2);
    expect(run.started).toEqual([2, 3]);
  });

  it('takes every message at one instant when a handler takes no time', () => {
    const run = runPool([{ at: 400, count: 100 }], { cap: 50, start: 50, rate: 0 }, 0, 0);
    expect(run.waves).toEqual([{ start: 400, end: 400, count: 100, init: 0 }]);
  });

  it('runs nothing when no message arrives', () => {
    expect(runPool([{ at: 0, count: 0 }], { cap: 5, start: 5, rate: 300 }, 100, 50)).toEqual({
      waves: [],
      started: [],
      taken: [],
      environments: 0,
      end: 0,
    });
  });

  it('starts each full batch at once and holds a partial batch for the window', () => {
    const run = runPool([{ at: 0, count: 25 }], { cap: 5, start: 5, rate: 0 }, (n) => 100 + n, 0, {
      size: 10,
      window: 1000,
    });
    expect(run.waves).toEqual([
      { start: 0, end: 110, count: 2, init: 0, batch: 10 },
      { start: 1000, end: 1105, count: 1, init: 0, batch: 5 },
    ]);
    expect(run.started).toEqual([2, 3]);
    expect(run.taken).toEqual([20, 25]);
    expect(run.environments).toBe(2);
    expect(takenBy(run, 999)).toBe(20);
    expect(takenBy(run, 1000)).toBe(25);
  });

  it('fills a partial batch from a later arrival before the window runs out', () => {
    const run = runPool(
      [
        { at: 0, count: 5 },
        { at: 300, count: 5 },
      ],
      { cap: 5, start: 5, rate: 0 },
      (n) => 100 + n,
      0,
      { size: 10, window: 1000 }
    );
    expect(run.waves).toEqual([{ start: 300, end: 410, count: 1, init: 0, batch: 10 }]);
  });

  it('starts a partial batch at once when the window is zero', () => {
    const run = runPool([{ at: 0, count: 5 }], { cap: 5, start: 5, rate: 0 }, (n) => 100 + n, 0, {
      size: 10,
      window: 0,
    });
    expect(run.waves).toEqual([{ start: 0, end: 105, count: 1, init: 0, batch: 5 }]);
  });

  it('starts a partial batch whose window ran out on the next free slot', () => {
    const run = runPool([{ at: 0, count: 15 }], { cap: 1, start: 1, rate: 0 }, 100, 0, { size: 10, window: 50 });
    expect(run.waves).toEqual([
      { start: 0, end: 100, count: 1, init: 0, batch: 10 },
      { start: 100, end: 200, count: 1, init: 0, batch: 5 },
    ]);
  });

  it('counts a pool of waves that it did not schedule as it counts its own', () => {
    const run = poolOf([
      { start: 0, end: 150, count: 2, init: 50, batch: 10 },
      { start: 150, end: 250, count: 1, init: 0, batch: 5 },
      { start: 300, end: 900, count: 1, init: 0 },
    ]);
    expect(run.started).toEqual([2, 3, 4]);
    expect(run.taken).toEqual([20, 25, 26]);
    expect(run.environments).toBe(2);
    expect(run.end).toBe(900);
    expect(poolOf([])).toEqual({ waves: [], started: [], taken: [], environments: 0, end: 0 });
  });

  it('does not draw a lane past the mark limit', () => {
    const run = runPool([{ at: 0, count: markLimit + 1 }], { cap: 1, start: 1, rate: 0 }, 10, 0);
    expect(marks(run)).toEqual({ waves: [], hidden: markLimit + 1 });
    const short = runPool([{ at: 0, count: 3 }], { cap: 1, start: 1, rate: 0 }, 10, 0);
    expect(marks(short).hidden).toBe(0);
  });
});

describe('Inbox and source schedule', () => {
  it('runs ten warm, scaled emails as one inbox wave and two source waves', () => {
    const input = slice({ ...flat, E: 10, L: 100_000 });
    const schedule = scheduleSlice(input);
    expect(schedule.inbox.waves).toEqual([{ start: 25, end: 525, count: 10, init: 0 }]);
    expect(schedule.releases).toEqual([{ at: 465, amount: 100 }]);
    expect(schedule.sources.waves).toEqual([
      { start: 490, end: 6940, count: 50, init: 0 },
      { start: 6940, end: 13_390, count: 50, init: 0 },
    ]);
    expect(emailsWaiting(input, schedule, 24)).toBe(10);
    expect(emailsWaiting(input, schedule, 25)).toBe(0);
    expect(sourcesWaiting(schedule, 464)).toBe(0);
    expect(sourcesWaiting(schedule, 465)).toBe(100);
    expect(sourcesWaiting(schedule, 490)).toBe(50);
    expect(sourcesWaiting(schedule, 6940)).toBe(0);
    expect(sourceArrivalNear(schedule, 465, 80)).toEqual({ at: 465, amount: 100 });
    expect(sourceArrivalNear(schedule, 300, 80)).toBeNull();
  });

  it('starts ten emails on five cold handlers per queue that scale up', () => {
    const schedule = scheduleSlice(slice({ E: 10, L: 100_000 }));
    expect(schedule.inbox.waves[0]).toEqual({ start: 25, end: 925, count: 5, init: 400 });
    expect(schedule.inbox.waves[1]).toEqual({ start: 225, end: 1125, count: 1, init: 400 });
    expect(schedule.inbox.environments).toBe(9);
    expect(schedule.inbox.end).toBe(1725);
    expect(schedule.sources.environments).toBe(50);
    expect(schedule.sources.end).toBe(21_440);
  });

  it('releases a shorter last put wave from each handler', () => {
    const input = slice({ ...flat, E: 1, S: 25, in_c: 10, delay_in: 0 });
    const schedule = scheduleInbox(input);
    expect(schedule.releases).toEqual([
      { at: 440, amount: 10 },
      { at: 560, amount: 10 },
      { at: 680, amount: 5 },
    ]);
    expect(sourcesReleased(schedule, 679)).toBe(20);
    expect(sourcesReleased(schedule, 680)).toBe(25);
  });

  it('delays the releases of a cold handler by its INIT', () => {
    const input = slice({ E: 1, S: 1, delay_in: 0, in_init_t: 300 });
    expect(scheduleInbox(input).releases).toEqual([{ at: 740, amount: 1 }]);
  });

  it('releases every put at the prefix when a put takes no time', () => {
    const input = slice({ ...flat, E: 1, S: 10, in_c: 3, in_storage_store_t: 0, delay_in: 0 });
    expect(scheduleInbox(input).releases).toEqual([{ at: 320, amount: 10 }]);
  });

  it('starts a source handler on each source as soon as a slot is free', () => {
    const input = slice({
      ...flat,
      E: 1,
      S: 3,
      in_c: 1,
      S_q_c: 2,
      L: 0,
      in_request_ledger_acknowledge_t: 0,
      in_request_ledger_record_t: 0,
      in_storage_read_t: 0,
      in_email_parser_parse_t: 0,
      in_storage_store_t: 100,
      in_storage_delete_t: 0,
      src_request_ledger_record_t: 0,
      src_storage_read_t: 0,
      src_excel_sheet_parser_parse_t: 0,
      src_storage_delete_t: 250,
      delay_in: 0,
      delay_src: 0,
    });
    const schedule = scheduleSlice(input);
    expect(schedule.sources.waves).toEqual([
      { start: 100, end: 350, count: 1, init: 0 },
      { start: 200, end: 450, count: 1, init: 0 },
      { start: 350, end: 600, count: 1, init: 0 },
    ]);
    expect(sourcesWaiting(schedule, 300)).toBe(1);
    expect(sourcesWaiting(schedule, 350)).toBe(0);
  });

  it('schedules no source when an email has no sources', () => {
    const schedule = scheduleSlice(slice({ S: 0 }));
    expect(schedule.releases).toEqual([]);
    expect(schedule.sources.waves).toEqual([]);
    expect(sourcesWaiting(schedule, 1000)).toBe(0);
    expect(sourceArrivalNear(schedule, 1000, 80)).toBeNull();
  });
});

describe('Order write limit', () => {
  const leadsTime = (input: SliceInputs) => {
    const schedule = scheduleSlice(input);
    return schedule.leads.end - schedule.leadReleases[0]!.at;
  };
  const runs = (input: SliceInputs) =>
    scheduleSlice(input).leads.waves.map(({ start, end, count, init, wait }) => ({
      time: end - start - init,
      count,
      init,
      wait,
    }));

  it('gives the pool the rest of each environment, and forever to a new one', () => {
    const rests: number[] = [];
    runPool(
      [
        { at: 0, count: 2 },
        { at: 500, count: 3 },
      ],
      { cap: 5, start: 5, rate: 0 },
      100,
      0,
      { size: 1, window: 0 },
      (_messages, rest) => {
        rests.push(rest);
        return 0;
      }
    );
    const never = Number.POSITIVE_INFINITY;
    expect(rests).toEqual([never, 400, never]);
  });

  it('adds the wait to the run and keeps it on the wave', () => {
    const { waves, end } = runPool(
      [{ at: 0, count: 2 }],
      { cap: 1, start: 1, rate: 0 },
      100,
      0,
      { size: 1, window: 0 },
      (_messages, rest) => (rest === 0 ? 900 : 0)
    );
    expect(waves).toEqual([
      { start: 0, end: 100, count: 1, init: 0 },
      { start: 100, end: 1100, count: 1, init: 0, wait: 900 },
    ]);
    expect(end).toBe(1100);
  });

  it('gives the first batch of a new environment no wait, and each later batch the whole wait', () => {
    const input = slice({ E: 1, S: 1, L: 30, esm_start: 1, esm_rate: 0, L_q_c: 1 });
    expect(runs(input)).toEqual([
      { time: 80, count: 1, init: input.ld_init_t, wait: undefined },
      { time: 1000, count: 1, init: 0, wait: 920 },
      { time: 1000, count: 1, init: 0, wait: 920 },
    ]);
  });

  it('gives a partial batch after the batching window no wait, as the bucket filled again', () => {
    const input = slice({ ...flat, E: 1, S: 1, L: 25, src_c: 2 });
    expect(runs(input).map(({ wait }) => wait)).toEqual([undefined, undefined]);
  });

  it('writes the default burst at the order write limit', () => {
    expect(leadsTime(sliceDefaults)).toBeGreaterThan(2_500_000);
    expect(leadsTime(sliceDefaults)).toBeLessThan(2_530_000);
  });

  it('makes a burst of 10x more emails take 10x longer', () => {
    const time = leadsTime(slice({ E: 500 }));
    expect(time).toBeGreaterThan(25_000_000);
    expect(time).toBeLessThan(25_030_000);
  });

  it('keeps a slower handler below the limit, as it finds its tokens ready', () => {
    const slow = slice({ ld_order_repository_store_t: 1920 });
    expect(leadsTime(slow)).toBeGreaterThan(4_900_000);
  });
});

describe('Lead schedule', () => {
  it('pushes the leads of each send wave and holds the last partial batch for the window', () => {
    const input = slice({ ...flat, E: 1, S: 1, L: 25, src_c: 2 });
    const schedule = scheduleSlice(input);
    expect(schedule.sources.waves).toEqual([{ start: 490, end: 1180, count: 1, init: 0 }]);
    expect(schedule.leadReleases).toEqual([
      { at: 1000, amount: 20 },
      { at: 1120, amount: 5 },
    ]);
    expect(schedule.leadsReleased).toEqual([20, 25]);
    expect(schedule.leads.waves).toEqual([
      { start: 1025, end: 1105, count: 2, init: 0, batch: 10 },
      { start: 11_145, end: 11_225, count: 1, init: 0, batch: 5 },
    ]);
    expect(leadsWaiting(schedule, -1)).toBe(0);
    expect(leadsWaiting(schedule, 1010)).toBe(20);
    expect(leadsWaiting(schedule, 1025)).toBe(0);
    expect(leadsWaiting(schedule, 1120)).toBe(5);
    expect(leadsWaiting(schedule, 11_145)).toBe(0);
    expect(leadArrivalNear(schedule, 1005, 15)).toEqual({ at: 1000, amount: 20 });
    expect(leadArrivalNear(schedule, 1060, 15)).toBeNull();
  });

  it('starts lead handlers while the source handlers still push', () => {
    const schedule = scheduleSlice(sliceDefaults);
    expect(schedule.leads.waves[0]!.start).toBeLessThan(schedule.sources.end);
    expect(schedule.leads.taken.at(-1)).toBe(sliceDefaults.E * sliceDefaults.S * sliceDefaults.L);
    expect(schedule.leads.environments).toBe(sliceDefaults.L_q_c);
    expect(schedule.leads.end).toBeGreaterThan(schedule.sources.end);
  });

  it('schedules no lead when the sources hold no leads', () => {
    const schedule = scheduleSlice(slice({ L: 0 }));
    expect(schedule.leadReleases).toEqual([]);
    expect(schedule.leads.waves).toEqual([]);
    expect(leadsWaiting(schedule, 1000)).toBe(0);
  });
});

/**
 * A slow reference: one message at a time. Each message starts at the first time a slot is free under the scale-up,
 * on a free warm environment when there is one, else on a new environment that runs INIT first.
 */
function reference(input: SliceInputs) {
  const pool = (arrivals: number[], cap: number, duration: number, init: number) => {
    arrivals.sort((a, b) => a - b);
    const origin = arrivals[0] ?? 0;
    /** AWS adds one invocation every 60,000 / rate ms, up to the cap. */
    const steps =
      input.esm_rate > 0
        ? Array.from(
            { length: Math.max(0, cap - input.esm_start) },
            (_, step) => origin + ((step + 1) * 60_000) / input.esm_rate
          )
        : [];
    const limit = (time: number) => Math.min(cap, input.esm_start + steps.filter((step) => step <= time).length);
    const frees: number[] = [];
    const starts: { start: number; init: number }[] = [];
    let end = 0;
    for (const at of arrivals) {
      let time = at;
      while (frees.filter((free) => free > time).length >= limit(time)) {
        time = Math.min(...frees.filter((free) => free > time), ...steps.filter((step) => step > time));
      }
      const warm = frees.findIndex((free) => free <= time);
      const wait = warm >= 0 ? 0 : init;
      const free = time + wait + duration;
      if (warm >= 0) frees[warm] = free;
      else frees.push(free);
      starts.push({ start: time, init: wait });
      end = Math.max(end, free);
    }
    return { starts, end, environments: frees.length };
  };
  const inbox = pool(Array<number>(input.E).fill(input.delay_in), input.E_q_c, inboxDuration(input), input.in_init_t);
  // One arrival for each unit a handler releases, after the delay to the next mapping.
  const arrivalsOf = (starts: { start: number; init: number }[], steps: Timeline, delay: number) =>
    starts.flatMap(({ start, init }) =>
      releasesOf(steps).flatMap(({ at, amount }) => Array<number>(amount).fill(start + init + at + delay))
    );
  const arrivals = arrivalsOf(inbox.starts, inboxTimeline(input), input.delay_src);
  const sources = pool(arrivals, input.S_q_c, sourceDuration(input), input.src_init_t);
  const leadArrivals = arrivalsOf(sources.starts, sourceTimeline(input), input.delay_ld);
  const leads = batchedReference(input, leadArrivals);
  return {
    inbox: [inbox.end, inbox.environments],
    sources: [sources.end, sources.environments],
    leads: [leads.end, leads.environments],
  };
}

/**
 * A slow reference for the lead mapping: one batch at a time, in arrival order.
 * A batch starts at the first time a slot is free and it is full, or its oldest lead has waited the window.
 */
function batchedReference(input: SliceInputs, arrivals: number[]) {
  arrivals.sort((a, b) => a - b);
  const origin = arrivals[0] ?? 0;
  const steps =
    input.esm_rate > 0
      ? Array.from(
          { length: Math.max(0, input.L_q_c - input.esm_start) },
          (_, step) => origin + ((step + 1) * 60_000) / input.esm_rate
        )
      : [];
  const limit = (time: number) => Math.min(input.L_q_c, input.esm_start + steps.filter((step) => step <= time).length);
  const frees: number[] = [];
  let end = 0;
  let index = 0;
  let arrived = 0;
  let time = origin;
  while (index < arrivals.length) {
    time = Math.max(time, arrivals[index]!);
    for (;;) {
      while (arrived < arrivals.length && arrivals[arrived]! <= time) arrived++;
      if (frees.filter((free) => free > time).length >= limit(time)) {
        time = Math.min(...frees.filter((free) => free > time), ...steps.filter((step) => step > time));
        continue;
      }
      if (arrived - index >= input.ld_batch || time >= arrivals[index]! + input.ld_window_t) break;
      time = Math.min(arrivals[arrived] ?? Number.POSITIVE_INFINITY, arrivals[index]! + input.ld_window_t);
    }
    const batch = Math.min(input.ld_batch, arrived - index);
    index += batch;
    // The environment that has rested longest takes the batch.
    const rested = frees.filter((free) => free <= time);
    const warm = rested.length > 0 ? frees.indexOf(Math.min(...rested)) : -1;
    const rest = warm >= 0 ? time - frees[warm]! : Number.POSITIVE_INFINITY;
    const free =
      time + (warm >= 0 ? 0 : input.ld_init_t) + leadTokenWait(input, batch, rest) + leadDuration(input, batch);
    if (warm >= 0) frees[warm] = free;
    else frees.push(free);
    end = Math.max(end, free);
  }
  return { end, environments: frees.length };
}

describe('Slot schedule against a one-message-at-a-time reference', () => {
  it('agrees on the end and the environment count of all three stages', () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let index = 0; index < 300; index++) {
      const input = slice({
        E: 1 + random(30),
        S: random(6),
        E_q_c: 1 + random(20),
        in_c: 1 + random(4),
        S_q_c: 1 + random(30),
        L: random(3) === 0 ? 0 : random(500),
        src_c: 1 + random(10),
        in_storage_store_t: random(300),
        src_storage_read_t: random(2000),
        row_b: random(3) === 0 ? 0 : random(5000),
        in_storage_mb_t: random(3) === 0 ? 0 : random(40),
        src_storage_mb_t: random(3) === 0 ? 0 : random(40),
        in_init_t: random(3) === 0 ? 0 : random(800),
        src_init_t: random(3) === 0 ? 0 : random(800),
        esm_start: 1 + random(6),
        esm_rate: random(4) === 0 ? 0 : random(2000),
        delay_in: random(100),
        delay_src: random(100),
        L_q_c: 1 + random(30),
        ld_batch: 1 + random(25),
        ld_window_t: random(3) === 0 ? 0 : random(5000),
        ld_c: 1 + random(10),
        ld_order_repository_store_t: random(300),
        ld_init_t: random(3) === 0 ? 0 : random(800),
        delay_ld: random(100),
        ld_writes: 1 + random(40),
      });
      const schedule = scheduleSlice(input);
      const expected = reference(input);
      // The inputs ride along so a failure names the case that broke.
      expect({
        input,
        inbox: [schedule.inbox.end, schedule.inbox.environments],
        sources: [schedule.sources.end, schedule.sources.environments],
        leads: [schedule.leads.end, schedule.leads.environments],
      }).toEqual({ input, ...expected });
    }
  });
});
