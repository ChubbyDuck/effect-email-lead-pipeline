import { Effect, Fiber, Layer, Random } from 'effect';
import { TestClock } from 'effect/testing';

/**
 * Waits for a fiber that runs on the TestClock. A retry waits on the clock, so the clock moves until the fiber ends.
 * The small step keeps the sleeps of the fiber in their order.
 */
export const awaitOnTestClock = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  TestClock.adjust('100 millis').pipe(
    Effect.repeat({ until: () => fiber.pollUnsafe() !== undefined }),
    Effect.andThen(Fiber.await(fiber))
  );

/** Runs an effect to its end on the TestClock and gives its exit. */
export const exitOnTestClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.forkChild(effect).pipe(Effect.flatMap(awaitOnTestClock));

/** Makes the jitter change no wait, so a case can name the exact time of each attempt. */
export const NoJitter = Layer.succeed(Random.Random, { nextIntUnsafe: () => 0, nextDoubleUnsafe: () => 0.5 });
