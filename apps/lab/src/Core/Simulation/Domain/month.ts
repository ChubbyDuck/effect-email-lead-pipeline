/** Days in the month the monthly figures cover. */
export const monthDays = 30;

/** How often a burst arrives. */
export const monthDefaults = {
  /** Bursts each day. Each burst is E emails, with their sources and leads. */
  N: 1,
};
export type MonthInputs = typeof monthDefaults;

/** Bursts in one month. */
export function monthlyBursts(input: MonthInputs) {
  return input.N * monthDays;
}
