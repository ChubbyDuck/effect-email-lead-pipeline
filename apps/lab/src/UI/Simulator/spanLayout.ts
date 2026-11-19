import { number, seconds } from './format';

/** Fit shows the whole horizon. Each step doubles that scale. */
export const minZoom = 1;
export const maxZoom = 256;

export function plotWidthAtZoom(fitWidth: number, zoom: number) {
  return fitWidth * zoom;
}

export function nextZoom(zoom: number, direction: 1 | -1) {
  const stepped = direction > 0 ? zoom * 2 : zoom / 2;
  return Math.min(maxZoom, Math.max(minZoom, stepped));
}

/** Pixels of wheel travel that double or halve the scale. A line is one notch. */
const wheelNotch = 100;

/**
 * Scale for one wheel movement. Rolling up stretches the clock; rolling down shrinks it.
 * The amount follows the wheel, and the result stays inside the fit-to-256× range.
 */
export function zoomAtWheel(zoom: number, deltaY: number, deltaMode = 0) {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 800 : deltaY;
  if (pixels === 0) return zoom;
  const next = zoom * 2 ** (-pixels / wheelNotch);
  return Math.min(maxZoom, Math.max(minZoom, next));
}

export function formatZoom(zoom: number) {
  const rounded = Math.round(zoom * 100) / 100;
  if (Number.isInteger(rounded)) return `${rounded}×`;
  return `${rounded.toFixed(2).replace(/0$/, '')}×`;
}

/** Clock time under a viewport pixel, given how far the lane is scrolled. */
export function timeUnderPointer(
  scroll: number,
  px: number,
  contentWidth: number,
  svgWidth: number,
  plotWidth: number,
  horizon: number,
  origin: number
) {
  if (contentWidth === 0 || plotWidth === 0 || horizon === 0 || svgWidth === 0) return 0;
  const viewX = ((scroll + px) / contentWidth) * svgWidth;
  return ((viewX - origin) / plotWidth) * horizon;
}

/** Scroll that keeps `time` on the viewport pixel `px` after the clock changes width. */
export function scrollHoldingTime(
  time: number,
  px: number,
  contentWidth: number,
  svgWidth: number,
  plotWidth: number,
  horizon: number,
  origin: number
) {
  if (svgWidth === 0 || contentWidth === 0) return 0;
  const viewX = origin + (horizon === 0 ? 0 : (time / horizon) * plotWidth);
  return (viewX / svgWidth) * contentWidth - px;
}

/**
 * Width of one handler on the shared clock. A bar thinner than a pixel is drawn
 * one pixel wide so it can be seen; the duration written above it is the true time.
 */
export function barWidthOnAxis(start: number, end: number, horizon: number, plotWidth: number) {
  if (!(horizon > 0)) return 3;
  return Math.max(((end - start) / horizon) * plotWidth, 1);
}

/**
 * Width of each timing inside a bar, in the same proportion as its duration.
 * A timing of 0 ms takes no width.
 */
export function spanWidths(durations: readonly number[], barWidth: number): number[] {
  const count = durations.length;
  if (count === 0 || barWidth <= 0) return durations.map(() => 0);
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  if (total <= 0) {
    const share = barWidth / count;
    return durations.map(() => share);
  }
  return durations.map((duration) => (duration / total) * barWidth);
}

/** How long one handler runs. Milliseconds, until the bar is long enough that seconds read more clearly. */
export function barDuration(ms: number) {
  if (ms >= 10_000) return seconds(ms);
  return `${number(Math.round(ms))} ms`;
}

/**
 * Rows that touch the band from `top` to `bottom`, as an inclusive index range.
 * Rows are stacked down a lane, so both `tops` and `bottoms` only grow. Two binary searches find the range.
 * The range is empty when `last` is less than `first`.
 */
export function rowsInBand(tops: readonly number[], bottoms: readonly number[], top: number, bottom: number) {
  let low = 0;
  let high = bottoms.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (bottoms[middle]! < top) low = middle + 1;
    else high = middle;
  }
  const first = low;
  low = 0;
  high = tops.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tops[middle]! <= bottom) low = middle + 1;
    else high = middle;
  }
  return { first, last: low - 1 };
}
