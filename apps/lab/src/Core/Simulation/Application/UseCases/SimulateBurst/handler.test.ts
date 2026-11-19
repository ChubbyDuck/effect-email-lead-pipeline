import { describe, expect, it } from 'vitest';

import { isWhole, waitingAt } from '#Core/Simulation/Domain/lane';
import { type SliceInputs } from '#Core/Simulation/Domain/sources';
import { sliceDefaults } from '#Core/Simulation/Domain/testing/roundDefaults';

import { handler } from './handler';

const simulate = (overrides: Partial<SliceInputs> = {}) => handler({ knobs: { ...sliceDefaults, ...overrides } });

describe('SimulateBurst', () => {
  it('gives the known waves of the default knobs', () => {
    const { schedule, horizon } = simulate();

    expect(schedule.inbox.waves).toHaveLength(38);
    expect(schedule.inbox.waves[0]).toMatchObject({ start: 25, end: 2280, count: 5 });
    expect(schedule.sources.waves).toHaveLength(444);
    expect(schedule.sources.waves[0]).toMatchObject({ start: 2245, end: 3752, count: 5 });
    expect(schedule.leads.waves).toHaveLength(12_785);
    expect(schedule.leads.waves[0]).toMatchObject({ start: 3237, end: 3717, count: 5, batch: 10 });
    expect(horizon).toBe(2_522_317);
  });

  it('counts every handler of the default burst in the swarms', () => {
    const { lanes } = simulate();

    expect(lanes.inbox.swarm.handlers).toBe(50);
    expect(lanes.sources.swarm.handlers).toBe(500);
    expect(lanes.leads.swarm.handlers).toBe(500_000);
    expect(lanes.leads.swarm.end).toBe(2_522_317);
  });

  it('draws the wait of a warm lead handler, and moves its orders after the wait', () => {
    const { lanes } = simulate({ E: 1, S: 1, L: 30, esm_start: 1, esm_rate: 0, L_q_c: 1 });
    const [cold, warm] = lanes.leads.rows;

    expect(cold?.pieces.map((piece) => piece.tone)).toEqual(['init', 'parse', 'ledger', 'store', 'ledger']);
    expect(warm?.wave.wait).toBe(920);
    expect(warm?.pieces.map((piece) => piece.tone)).toEqual(['parse', 'ledger', 'wait', 'store', 'ledger']);
    expect(warm?.pieces.find((piece) => piece.tone === 'store')).toMatchObject({ start: 960, end: 980, amount: 10 });
  });

  it('hides the waves of a lane past the mark limit', () => {
    const { lanes } = simulate();

    expect(lanes.inbox.rows).toHaveLength(38);
    expect(lanes.inbox.hidden).toBe(0);
    expect(lanes.leads.rows).toEqual([]);
    expect(lanes.leads.hidden).toBe(12_785);
  });

  it('gives each wave the ranges of its handlers, INIT first on a cold one', () => {
    const { lanes } = simulate();
    const [first] = lanes.inbox.rows;

    expect(first?.wave.init).toBeGreaterThan(0);
    expect(first?.pieces[0]).toMatchObject({ tone: 'init', start: 0, end: first?.wave.init });
    expect(first?.pieces.at(-1)?.end).toBe(first!.wave.end - first!.wave.start);
  });

  it('fills the queue in front of each lane with every email, source, and lead of the burst', () => {
    const { lanes } = simulate();

    expect([lanes.inbox.total, lanes.sources.total, lanes.leads.total]).toEqual([50, 500, 5_000_000]);
    expect([lanes.inbox.cap, lanes.sources.cap, lanes.leads.cap]).toEqual([50, 50, 200]);
    expect(waitingAt(lanes.inbox, 0)).toBe(50);
    expect(waitingAt(lanes.inbox, 25)).toBe(45);
    expect(waitingAt(lanes.sources, 0)).toBe(0);
    expect(waitingAt(lanes.leads, lanes.leads.pool.end)).toBe(0);
  });

  it('marks a wave whole when it holds every email, every source, or every batch', () => {
    const flat = { esm_start: 1000, in_init_t: 0, src_init_t: 0, ld_init_t: 0 };
    const { lanes } = simulate({ ...flat, E: 4, S: 2, L: 10 });

    expect(lanes.inbox.rows.map(({ wave }) => [wave.count, isWhole(lanes.inbox, wave)])).toEqual([[4, true]]);
    expect(lanes.sources.rows.map(({ wave }) => [wave.count, isWhole(lanes.sources, wave)])).toEqual([[8, true]]);
    expect(lanes.leads.rows.map(({ wave }) => [wave.count, isWhole(lanes.leads, wave)])).toEqual([[8, true]]);
    expect(isWhole(simulate().lanes.inbox, simulate().lanes.inbox.rows[0]!.wave)).toBe(false);
  });

  it('gives the known month total of the default knobs', () => {
    const { month, charges } = simulate();

    expect(month.bursts).toBe(30);
    expect(month.cost.value).toBeCloseTo(200.628_747_144, 9);
    expect(month.parts.at(-1)).toEqual({ label: 'Idle polling', cost: charges.idle.cost.value });
  });

  it('runs the default knobs inside every limit', () => {
    const { limits, flagged } = simulate();

    expect(limits).toEqual([]);
    expect(flagged.size).toBe(0);
  });

  it('flags the keys of a knob past a limit', () => {
    const { flagged } = simulate({ L: 100_000 });

    expect([...flagged].sort()).toEqual(['L', 'S', 'row_b']);
  });

  it('changes the month total and not the cost of one burst with the bursts a day', () => {
    const one = simulate({ N: 1 });
    const four = simulate({ N: 4 });

    expect(four.charges.burst.applied.value).toBe(one.charges.burst.applied.value);
    expect(four.month.cost.value).toBeGreaterThan(one.month.cost.value);
    expect(four.month.cost.value - one.month.cost.value).toBeCloseTo(3 * 30 * one.charges.burst.applied.value, 9);
  });

  it('normalizes the knobs before it simulates', () => {
    const { knobs } = simulate({ E: 2.7, src_M: 1 });

    expect(knobs.E).toBe(2);
    expect(knobs.src_M).toBe(128);
  });
});
