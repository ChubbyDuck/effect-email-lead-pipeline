import { useEffect, useReducer, useState } from 'react';

import type { FeedEvent } from '#Core/Observation/Domain/requests';

import { initialFeed, reduceFeed } from './requestFeed';

/** The page keeps a pause in the browser, so that a reload does not start the polls again. */
const pausedKey = 'leads-monitor:requests-paused';

function storedPause() {
  try {
    return localStorage.getItem(pausedKey) === 'true';
  } catch {
    return false;
  }
}

function storePause(paused: boolean) {
  try {
    if (paused) localStorage.setItem(pausedKey, 'true');
    else localStorage.removeItem(pausedKey);
  } catch {
    // The pause then lasts only until a reload.
  }
}

/**
 * The live request ledger, from the stream of server-sent events. The browser reconnects a stream that closes. A pause
 * closes the stream, and the server stops its polls when no page listens.
 */
export function useRequestFeed() {
  const [state, dispatch] = useReducer(reduceFeed, initialFeed);
  const paused = state.connection === 'paused';

  useEffect(() => {
    if (paused) return;
    if (storedPause()) {
      dispatch({ type: 'paused' });
      return;
    }
    const stream = new EventSource('/api/requests');
    const take = (event: MessageEvent<string>) => dispatch(JSON.parse(event.data) as FeedEvent);
    stream.addEventListener('open', () => dispatch({ type: 'open' }));
    stream.addEventListener('error', () => dispatch({ type: 'closed' }));
    stream.addEventListener('entries', take);
    stream.addEventListener('status', take);
    return () => stream.close();
  }, [paused]);

  function setPaused(next: boolean) {
    storePause(next);
    dispatch({ type: next ? 'paused' : 'resumed' });
  }

  return { state, setPaused };
}

/** The current time in ms, renewed at each interval. */
export function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
