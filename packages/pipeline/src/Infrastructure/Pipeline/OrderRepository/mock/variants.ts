import type { Lead } from '@leads/shared/domain/types';
import { definePortMock } from '@leads/shared/testing/variants';
import { Cause, Clock, type Duration, Effect, Exit } from 'effect';

import {
  AuthenticationFailed,
  OrderRepository,
  OrderStoreFailed,
  OrderStoreTimedOut,
} from '#Core/Pipeline/Ports/OrderRepository';

type StoreError = AuthenticationFailed | OrderStoreTimedOut | OrderStoreFailed;

type ScriptedAttempt = {
  readonly after: Duration.Input;
  readonly then: Effect.Effect<void, StoreError>;
};

export type AttemptOutcome = 'pending' | 'succeeded' | StoreError['_tag'] | 'died' | 'interrupted';

export type StoreAttempt = {
  readonly lead: string;
  readonly attempt: number;
  readonly startedAt: number;
  readonly outcome: AttemptOutcome;
  readonly endedAt: number | undefined;
};

const succeedsAfter = (after: Duration.Input): ScriptedAttempt => ({ after, then: Effect.void });
const failsAfter = (after: Duration.Input, error: StoreError): ScriptedAttempt => ({ after, then: Effect.fail(error) });

export const crashingLeadDefect = new Error('Crashing lead');

// Keyed by `lead.extracted.name`; `attempt` counts this lead's own retries, starting at 1.
export const leadScripts: Readonly<Record<string, (attempt: number) => ScriptedAttempt>> = {
  Acme: () => succeedsAfter(0),
  Broken: () => failsAfter(0, new OrderStoreFailed({ reason: 'unavailable' })),
  Slow: () => succeedsAfter('2 seconds'),
  Flaky: (attempt) =>
    attempt < 3 ? failsAfter('1 second', new OrderStoreTimedOut({ reason: 'unavailable' })) : succeedsAfter('1 second'),
  Exhausted: () => failsAfter('1 second', new AuthenticationFailed({ reason: 'unavailable' })),
  Stalled: () => failsAfter('2 seconds', new OrderStoreTimedOut({ reason: 'unavailable' })),
  Hanging: () => ({ after: 0, then: Effect.never }),
  Crashing: () => ({ after: '1 second', then: Effect.die(crashingLeadDefect) }),
};

function outcomeOf(exit: Exit.Exit<void, StoreError>): AttemptOutcome {
  if (Exit.isSuccess(exit)) return 'succeeded';
  const failure = exit.cause.reasons.find(Cause.isFailReason);
  if (failure) return failure.error._tag;
  return exit.cause.reasons.some(Cause.isDieReason) ? 'died' : 'interrupted';
}

const orderRepositoryMock = definePortMock(OrderRepository, ({ method, record, observation }) => {
  const store = record('store');
  const attemptsByLead = new Map<string, number>();
  const attempts: { -readonly [K in keyof StoreAttempt]: StoreAttempt[K] }[] = [];

  const runScripted = (name: string) =>
    Effect.suspend(() => {
      const script = leadScripts[name];
      if (script === undefined) return Effect.die(new Error(`No store script for lead: ${name}`));
      const attempt = (attemptsByLead.get(name) ?? 0) + 1;
      attemptsByLead.set(name, attempt);
      const { after, then } = script(attempt);

      return Effect.gen(function* () {
        const entry = {
          lead: name,
          attempt,
          startedAt: yield* Clock.currentTimeMillis,
          outcome: 'pending' as AttemptOutcome,
          endedAt: undefined as number | undefined,
        };
        attempts.push(entry);
        yield* Effect.sleep(after).pipe(
          Effect.andThen(then),
          Effect.onExit((exit) =>
            Effect.map(Clock.currentTimeMillis, (now) => {
              entry.outcome = outcomeOf(exit);
              entry.endedAt = now;
            })
          )
        );
      });
    });

  return {
    variants: {
      store: method('store', {
        failsWithAuthenticationFailed: (lead) =>
          store(lead).pipe(Effect.andThen(Effect.fail(new AuthenticationFailed({ reason: 'unavailable' })))),
        failsWithOrderStoreTimedOut: (lead) =>
          store(lead).pipe(Effect.andThen(Effect.fail(new OrderStoreTimedOut({ reason: 'unavailable' })))),
        failsWithOrderStoreFailed: (lead) =>
          store(lead).pipe(Effect.andThen(Effect.fail(new OrderStoreFailed({ reason: 'unavailable' })))),
        followsLeadScripts: (lead: Lead) => store(lead).pipe(Effect.andThen(runScripted(lead.extracted.name ?? ''))),
        succeeds: store,
      }),
    },
    observation: {
      get calls() {
        return observation.calls;
      },
      get attempts(): readonly StoreAttempt[] {
        return attempts;
      },
    },
  };
});

export const orderRepositoryBuilder = orderRepositoryMock.builder;
export const makeOrderRepository = orderRepositoryMock.make;
