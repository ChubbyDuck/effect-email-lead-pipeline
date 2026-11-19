import type { WindowHours } from '#Core/Observation/Domain/time';

/** The window of the snapshot. The server function checks the hours before it makes the command. */
export type Command = {
  readonly windowHours: WindowHours;
};
