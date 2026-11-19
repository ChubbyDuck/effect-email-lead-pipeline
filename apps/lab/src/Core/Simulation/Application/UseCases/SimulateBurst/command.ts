import type { SliceInputs } from '#Core/Simulation/Domain/sources';

/** The knobs of the burst simulator. */
export type Command = {
  readonly knobs: SliceInputs;
};
