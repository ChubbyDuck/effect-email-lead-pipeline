/** One locale for the server and the browser, so that the page that the server renders is the page that hydrates. */
const locale = 'en-GB';

export const fmt = (value: number) => value.toLocaleString(locale);

export const time = (iso: string | undefined) =>
  iso ? new Date(iso).toLocaleTimeString(locale, { hour12: false }) : '';

export const dateTime = (iso: string | undefined) =>
  iso ? new Date(iso).toLocaleString(locale, { hour12: false }) : '';

export function ago(iso: string, now: number) {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 90) return `${Math.round(seconds)} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

export const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1048576
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${(value / 1048576).toFixed(1)} MiB`;

/** The class of a count that is a problem when it is not 0. */
export const countClass = (value: number, level: 'bad' | 'warn') =>
  value > 0 ? (level === 'bad' ? 'font-semibold text-crit' : 'font-semibold text-warn') : undefined;

/** A time with its milliseconds, such as `17:15:34.512`. */
export const clock = (iso: string | undefined) =>
  iso
    ? new Date(iso).toLocaleTimeString(locale, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hour12: false,
      })
    : '';

/** A length of time in ms, such as `447 ms`, `5.08 s`, or `2 min 5 s`. */
export function duration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** The time of an event after a start, such as `+0.42 s`. */
export const offset = (ms: number) => `+${duration(Math.max(0, ms))}`;

/** Numbers and amounts of US dollars. The formulas of the domain use the same format. */
export { amount, dollars as money, rawDollars } from '#Core/Observation/Domain/costs';
