import type { FeedListener } from '#Core/Observation/Domain/requests';

/** The listener that takes every entry that the feed holds, and after that only the entries that changed. */
export type Command = {
  readonly listener: FeedListener;
};
