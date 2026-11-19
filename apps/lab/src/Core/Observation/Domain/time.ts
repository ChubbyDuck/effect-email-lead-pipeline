import type { Series } from './snapshot';

/** In hours. The windows that a person can select. A window sets the time of the metrics and of the requests shown. */
export const windowChoices = [1, 3, 6, 12, 24] as const;

export type WindowHours = (typeof windowChoices)[number];

export const defaultWindowHours: WindowHours = 3;

export const toWindowHours = (value: unknown): WindowHours =>
  windowChoices.find((hours) => hours === Number(value)) ?? defaultWindowHours;

/** The most periods in one series. */
export const maxPeriods = 36;

/** In seconds. CloudWatch needs a multiple of 60. */
export const periodFor = (windowHours: number) => Math.max(60, Math.ceil((windowHours * 3600) / maxPeriods / 60) * 60);

export interface Window {
  readonly start: Date;
  readonly end: Date;
  readonly periodSeconds: number;
  readonly periods: number;
}

/** The periods that cover the last `windowHours`. The last period ends after `now`, so that it is aligned. */
export function windowOf(windowHours: number, now: Date): Window {
  const periodSeconds = periodFor(windowHours);
  const periodMs = periodSeconds * 1000;
  const periods = Math.ceil((windowHours * 3600) / periodSeconds);
  const end = new Date(Math.ceil(now.getTime() / periodMs) * periodMs);
  return { start: new Date(end.getTime() - periods * periodMs), end, periodSeconds, periods };
}

/** Puts datapoints into the periods of the window. A period without a datapoint holds 0. */
export function toSeries(window: Window, timestamps: readonly Date[], values: readonly number[]): Series {
  const series = Array.from({ length: window.periods }, () => 0);
  timestamps.forEach((timestamp, index) => {
    const slot = Math.floor((timestamp.getTime() - window.start.getTime()) / (window.periodSeconds * 1000));
    if (slot >= 0 && slot < window.periods) series[slot] = values[index] ?? 0;
  });
  return { start: window.start.toISOString(), periodSeconds: window.periodSeconds, values: series };
}

/** A length of time in its two largest units, such as `50 min`, `2 h 5 min`, or `3 d 22 h`. */
export function span(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/** In seconds. CloudWatch publishes a Lambda, SQS, or DynamoDB datapoint some minutes after the activity that it counts. */
export const metricDelaySeconds = 5 * 60;

/**
 * The time after which a snapshot has the metrics of the activity until `lastActivity`. A snapshot read before this
 * time can count too few runs, messages, and writes. No time when the snapshot was read after it.
 */
export function metricsCompleteAt(collectedAt: string, lastActivity: string | undefined): string | undefined {
  if (lastActivity === undefined) return undefined;
  const complete = Date.parse(lastActivity) + metricDelaySeconds * 1000;
  return Date.parse(collectedAt) < complete ? new Date(complete).toISOString() : undefined;
}
