import { describe, expect, it } from 'vitest';

import {
  barDuration,
  barWidthOnAxis,
  formatZoom,
  maxZoom,
  minZoom,
  nextZoom,
  plotWidthAtZoom,
  rowsInBand,
  scrollHoldingTime,
  spanWidths,
  timeUnderPointer,
  zoomAtWheel,
} from './spanLayout';

describe('Handler bar layout', () => {
  it('draws ranges in proportion to their durations', () => {
    expect(spanWidths([200, 80, 120, 80, 40], 520)).toEqual([200, 80, 120, 80, 40]);
  });

  it('keeps a short range short inside a long handler', () => {
    const [get, parse, send, record, del] = spanWidths([200, 150, 60_000, 20, 40], 60_410);
    expect(get).toBeCloseTo(200);
    expect(parse).toBeCloseTo(150);
    expect(send).toBeCloseTo(60_000);
    expect(record).toBeCloseTo(20);
    expect(del).toBeCloseTo(40);
  });

  it('gives a timing of 0 ms no width', () => {
    expect(spanWidths([200, 0, 40], 240)).toEqual([200, 0, 40]);
  });

  it('draws a handler as its share of the horizon', () => {
    const horizon = 121_340;
    const plot = 848;
    expect(barWidthOnAxis(0, 520, horizon, plot)).toBeCloseTo((520 / horizon) * plot);
    expect(barWidthOnAxis(400, 60_870, horizon, plot)).toBeCloseTo((60_470 / horizon) * plot);
  });

  it('draws a hairline one pixel wide', () => {
    expect(barWidthOnAxis(0, 1, 200_000, 848)).toBe(1);
  });

  it('scales the plot with zoom and leaves fit at the panel width', () => {
    expect(plotWidthAtZoom(848, 1)).toBe(848);
    expect(plotWidthAtZoom(848, 8)).toBe(848 * 8);
  });

  it('steps zoom by doubling and stops at the ends', () => {
    expect(nextZoom(minZoom, -1)).toBe(minZoom);
    expect(nextZoom(1, 1)).toBe(2);
    expect(nextZoom(8, -1)).toBe(4);
    expect(nextZoom(maxZoom, 1)).toBe(maxZoom);
  });

  it('stretches the clock with the wheel and stops at the ends', () => {
    expect(zoomAtWheel(4, 0)).toBe(4);
    expect(zoomAtWheel(1, -100)).toBe(2);
    expect(zoomAtWheel(8, 100)).toBe(4);
    expect(zoomAtWheel(1, -1, 1)).toBeCloseTo(2 ** (16 / 100));
    expect(zoomAtWheel(minZoom, 100)).toBe(minZoom);
    expect(zoomAtWheel(maxZoom, -100)).toBe(maxZoom);
  });

  it('writes the scale without a trailing zero', () => {
    expect(formatZoom(1)).toBe('1×');
    expect(formatZoom(1.5)).toBe('1.5×');
    expect(formatZoom(12.25)).toBe('12.25×');
  });

  it('keeps the time under the pointer when the clock stretches', () => {
    const horizon = 121_340;
    const client = 800;
    const origin = 132;
    const fit = 1000 - origin - 72;
    const scroll = 180;
    const px = 360;
    const widthAt = (zoom: number) => {
      const plot = plotWidthAtZoom(fit, zoom);
      const svg = origin + plot + 72;
      return { plot, svg, content: (svg / 1000) * client };
    };
    const before = widthAt(2);
    const time = timeUnderPointer(scroll, px, before.content, before.svg, before.plot, horizon, origin);
    const after = widthAt(8);
    const next = scrollHoldingTime(time, px, after.content, after.svg, after.plot, horizon, origin);
    expect(timeUnderPointer(next, px, after.content, after.svg, after.plot, horizon, origin)).toBeCloseTo(time);
  });

  it('writes a short bar in milliseconds and a long bar in seconds', () => {
    expect(barDuration(520)).toBe('520 ms');
    expect(barDuration(40)).toBe('40 ms');
    expect(barDuration(60_470)).toBe('60.47 s');
  });
});

describe('Rows near the screen', () => {
  const tops = [0, 50, 100, 150];
  const bottoms = [40, 90, 140, 190];

  it('finds the rows that touch a band', () => {
    expect(rowsInBand(tops, bottoms, 45, 99)).toEqual({ first: 1, last: 1 });
    expect(rowsInBand(tops, bottoms, 40, 100)).toEqual({ first: 0, last: 2 });
    expect(rowsInBand(tops, bottoms, -500, 500)).toEqual({ first: 0, last: 3 });
  });

  it('finds no row in a gap or past the lane', () => {
    expect(rowsInBand(tops, bottoms, 41, 49)).toEqual({ first: 1, last: 0 });
    expect(rowsInBand(tops, bottoms, 200, 300)).toEqual({ first: 4, last: 3 });
    expect(rowsInBand([], [], 0, 100)).toEqual({ first: 0, last: -1 });
  });
});
