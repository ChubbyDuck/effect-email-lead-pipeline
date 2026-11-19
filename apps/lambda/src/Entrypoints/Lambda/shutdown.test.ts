import { Effect } from 'effect';
import { afterEach, expect, test, vi } from 'vitest';

import { bindLambdaShutdown, withLambdaShutdown } from './shutdown';

afterEach(() => {
  vi.useRealTimers();
});

test('aborts when the invocation deadline elapses', () => {
  vi.useFakeTimers();
  const shutdown = bindLambdaShutdown({ getRemainingTimeInMillis: () => 5_000 });

  expect(shutdown.signal.aborted).toBe(false);
  vi.advanceTimersByTime(5_000);

  expect(shutdown.signal.aborted).toBe(true);
  shutdown.dispose();
});

test('dispose cancels the deadline', () => {
  vi.useFakeTimers();
  const shutdown = bindLambdaShutdown({ getRemainingTimeInMillis: () => 5_000 });

  shutdown.dispose();
  vi.advanceTimersByTime(5_000);

  expect(shutdown.signal.aborted).toBe(false);
});

test('SIGTERM aborts the signal', () => {
  const shutdown = bindLambdaShutdown({ getRemainingTimeInMillis: () => 60_000 });

  process.emit('SIGTERM');

  expect(shutdown.signal.aborted).toBe(true);
  shutdown.dispose();
});

test('dispose removes the signal listener', () => {
  const shutdown = bindLambdaShutdown({ getRemainingTimeInMillis: () => 60_000 });

  shutdown.dispose();
  process.emit('SIGTERM');

  expect(shutdown.signal.aborted).toBe(false);
});

test('a shutdown abort interrupts the running effect', async () => {
  let interrupted = false;
  const pending = withLambdaShutdown({ getRemainingTimeInMillis: () => 60_000 }, (signal) =>
    Effect.runPromise(
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          })
        )
      ),
      { signal }
    )
  );

  process.emit('SIGTERM');

  await expect(pending).rejects.toThrow('All fibers interrupted without error');
  expect(interrupted).toBe(true);
});
