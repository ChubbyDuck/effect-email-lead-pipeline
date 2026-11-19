export type Command = {
  readonly requestID: string;
  /** In ms since the epoch. An active request can run until now. */
  readonly now: number;
};
