import { describe, expect, test } from 'vitest';

import { defaultWindowHours, metricsCompleteAt, periodFor, span, toSeries, toWindowHours, windowOf } from './time';

test.each([
  [1, 120, 30],
  [3, 300, 36],
  [24, 2400, 36],
])('splits a window of %i h into periods of %i s', (hours, periodSeconds, periods) => {
  expect(windowOf(hours, new Date('2026-10-09T13:51:18Z'))).toMatchObject({ periodSeconds, periods });
  expect(periodFor(hours) % 60).toBe(0);
});

test('aligns the window to the period, so that the last period holds the current time', () => {
  const window = windowOf(3, new Date('2026-10-09T13:51:18Z'));

  expect(window.end.toISOString()).toBe('2026-10-09T13:55:00.000Z');
  expect(window.start.toISOString()).toBe('2026-10-09T10:55:00.000Z');
});

test('puts each datapoint into its period and fills the empty periods with 0', () => {
  const window = windowOf(1, new Date('2026-10-09T14:00:00Z'));

  const series = toSeries(
    window,
    [new Date('2026-10-09T13:00:00Z'), new Date('2026-10-09T13:59:00Z'), new Date('2026-10-09T09:00:00Z')],
    [4, 7, 99]
  );

  expect(series.values).toHaveLength(30);
  expect(series.values[0]).toBe(4);
  expect(series.values[29]).toBe(7);
  expect(series.values.reduce((a, b) => a + b)).toBe(11);
});

test.each([
  [6, 6],
  ['12', 12],
  [5, defaultWindowHours],
  [undefined, defaultWindowHours],
  ['all', defaultWindowHours],
])('reads the window %j as %i h', (value, hours) => {
  expect(toWindowHours(value)).toBe(hours);
});

test.each([
  [42, '42 s'],
  [900, '15 min'],
  [3600, '1 h'],
  [7500, '2 h 5 min'],
  [341_700, '3 d 22 h'],
  [1_209_600, '14 d'],
])('writes %i s as %s', (seconds, text) => {
  expect(span(seconds)).toBe(text);
});

describe('metricsCompleteAt', () => {
  const lastActivity = '2026-10-13T14:15:40.000Z';

  test('gives the time of complete metrics when the snapshot was read too soon after the activity', () => {
    expect(metricsCompleteAt('2026-10-13T14:16:10.000Z', lastActivity)).toBe('2026-10-13T14:20:40.000Z');
  });

  test('gives the time when the activity came after the snapshot', () => {
    expect(metricsCompleteAt('2026-10-13T14:10:00.000Z', lastActivity)).toBe('2026-10-13T14:20:40.000Z');
  });

  test('gives no time when the snapshot was read after the delay', () => {
    expect(metricsCompleteAt('2026-10-13T14:20:40.000Z', lastActivity)).toBeUndefined();
  });

  test('gives no time without activity', () => {
    expect(metricsCompleteAt('2026-10-13T14:16:10.000Z', undefined)).toBeUndefined();
  });
});
