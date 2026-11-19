export const number = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value);
export const seconds = (ms: number) => `${number(ms / 1000)} s`;
/** Picks the largest unit that keeps the value readable: ms below 1 s, s below 1 min, then min + s. */
export const duration = (ms: number) => {
  if (Math.abs(ms) < 1000) return `${number(ms)} ms`;
  const totalMs = Math.round(ms);
  if (Math.abs(totalMs) < 60_000) return seconds(totalMs);
  const minutes = Math.trunc(totalMs / 60_000);
  const restMs = Math.abs(totalMs - minutes * 60_000);
  return restMs === 0 ? `${number(minutes)} min` : `${number(minutes)} min ${seconds(restMs)}`;
};
export const money = (value: number) =>
  `$${value.toFixed(value === 0 || Math.abs(value) >= 1 ? 2 : Math.abs(value) >= 0.01 ? 4 : 6)}`;
/** Keeps a unit price visible when it is smaller than money() can show. */
export const rate = (value: number) => {
  if (value === 0) return '$0.00';
  const trimmed = value.toFixed(12).replace(/(\.\d*?[1-9])0+$/, '$1');
  const fraction = trimmed.split('.')[1] ?? '';
  return fraction.length >= 2 ? `$${trimmed}` : `$${Number(trimmed).toFixed(2)}`;
};
