import { describe, expect, it } from 'vitest';

import { arrivalNear, isWhole, laneOf, waitingAt, type LaneParts } from './lane';
import { markLimit, poolOf, type HandlerWave } from './schedule';

const parts = (waves: readonly HandlerWave[], more: Partial<LaneParts> = {}): LaneParts => ({
  pool: poolOf(waves),
  piecesOf: () => [],
  outputOf: () => [],
  arrivals: [],
  total: 0,
  cap: 10,
  ...more,
});

const read = { tone: 'get', symbol: 'read', name: 'Read', detail: 'The read.', start: 0, end: 40 } as const;
const cold = { tone: 'init', symbol: 'INIT', name: 'Cold start', detail: 'The INIT.', start: 0, end: 50 } as const;

describe('The rows of a lane', () => {
  it('give each wave the pieces of its handlers', () => {
    const warm = { start: 0, end: 40, count: 2, init: 0 };
    const first = { start: 40, end: 130, count: 1, init: 50 };
    const lane = laneOf(
      parts([warm, first], { piecesOf: (wave) => (wave.init > 0 ? [cold, { ...read, start: 50, end: 90 }] : [read]) })
    );
    expect(lane.rows).toEqual([
      { wave: warm, pieces: [read] },
      { wave: first, pieces: [cold, { ...read, start: 50, end: 90 }] },
    ]);
    expect(lane.hidden).toBe(0);
  });

  it('are left out past the mark limit, and the lane counts them', () => {
    const waves = Array.from({ length: markLimit + 1 }, (_, index) => ({
      start: index,
      end: index + 1,
      count: 1,
      init: 0,
    }));
    const lane = laneOf(parts(waves));
    expect(lane.rows).toEqual([]);
    expect(lane.hidden).toBe(markLimit + 1);
  });
});

describe('The swarm of a lane', () => {
  it('counts the output of each wave from the end of its INIT', () => {
    const small = { start: 0, end: 100, count: 2, init: 20, batch: 1 };
    const large = { start: 50, end: 200, count: 1, init: 0, batch: 4 };
    const lane = laneOf(
      parts([small, large], {
        outputOf: (wave) => [{ start: 10, end: 30, amount: wave.batch ?? 1, calls: 1, waves: 1 }],
      })
    );
    expect(lane.swarm).toMatchObject({ start: 0, end: 200, handlers: 3, output: 2 * 1 + 4 });
    expect(lane.swarm.inFlight).toEqual([
      { at: 30, value: 2 },
      { at: 50, value: 0 },
      { at: 60, value: 4 },
      { at: 80, value: 0 },
    ]);
  });
});

describe('A whole wave', () => {
  it('holds every handler of the lane', () => {
    const all = { start: 0, end: 100, count: 5, init: 0, batch: 10 };
    expect(isWhole(laneOf(parts([all])), all)).toBe(true);

    const first = { start: 0, end: 100, count: 3, init: 0 };
    const rest = { start: 100, end: 200, count: 2, init: 0 };
    const split = laneOf(parts([first, rest]));
    expect(isWhole(split, first)).toBe(false);
    expect(isWhole(split, rest)).toBe(false);
  });
});

describe('The queue in front of a lane', () => {
  it('holds what arrived and what no handler took yet', () => {
    const lane = laneOf(
      parts([{ start: 100, end: 200, count: 2, init: 0, batch: 3 }], {
        arrivals: [
          { at: 300, amount: 1 },
          { at: 50, amount: 4 },
          { at: 50, amount: 2 },
        ],
      })
    );
    expect(lane.releases).toEqual([
      { at: 50, amount: 6 },
      { at: 300, amount: 1 },
    ]);
    expect(lane.released).toEqual([6, 7]);
    expect(waitingAt(lane, -1)).toBe(0);
    expect(waitingAt(lane, 49)).toBe(0);
    expect(waitingAt(lane, 50)).toBe(6);
    expect(waitingAt(lane, 100)).toBe(0);
    expect(waitingAt(lane, 300)).toBe(1);
  });

  it('shows the arrival nearest a time, inside a margin', () => {
    const lane = laneOf(
      parts([], {
        arrivals: [
          { at: 100, amount: 3 },
          { at: 200, amount: 5 },
        ],
      })
    );
    expect(arrivalNear(lane, 190, 15)).toEqual({ at: 200, amount: 5 });
    expect(arrivalNear(lane, 150, 15)).toBeNull();
  });

  it('never holds a negative count when a handler takes a message before it arrives', () => {
    const lane = laneOf(parts([{ start: 10, end: 90, count: 1, init: 0 }], { arrivals: [{ at: 20, amount: 1 }] }));
    expect(waitingAt(lane, 15)).toBe(0);
    expect(waitingAt(lane, 20)).toBe(0);
  });
});
