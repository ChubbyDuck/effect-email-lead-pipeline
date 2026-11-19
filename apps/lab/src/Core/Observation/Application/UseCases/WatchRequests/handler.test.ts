import { describe, expect, test } from 'vitest';

import type { FeedEvent, FeedListener } from '#Core/Observation/Domain/requests';
import type { RequestFeed } from '#Core/Observation/Ports/RequestFeed';

import { handler } from './handler';

/** A feed that a test drives by hand. */
function fakeFeed() {
  const listeners = new Set<FeedListener>();
  const requests: RequestFeed = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emit = (event: FeedEvent) => listeners.forEach((listener) => listener(event));
  return { requests, listeners, emit };
}

const status: FeedEvent = { type: 'status', ok: true, readAt: '2026-10-16T11:49:21.796Z' };

describe('WatchRequests', () => {
  test('gives the events of the feed to the listener', () => {
    const { requests, emit } = fakeFeed();
    const events: FeedEvent[] = [];

    handler({ requests }, { listener: (event) => events.push(event) });
    emit({ type: 'entries', entries: [] });
    emit(status);

    expect(events).toEqual([{ type: 'entries', entries: [] }, status]);
  });

  test('stops the events when the watch ends', () => {
    const { requests, listeners, emit } = fakeFeed();
    const events: FeedEvent[] = [];

    const stop = handler({ requests }, { listener: (event) => events.push(event) });
    stop();
    emit(status);

    expect(events).toEqual([]);
    expect(listeners.size).toBe(0);
  });
});
