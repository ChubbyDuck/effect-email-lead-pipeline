export type Command = {
  readonly requestIDs: readonly string[];
  /** In ms since the epoch. An active request can run until now. */
  readonly now: number;
};
