import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Context, SQSEvent } from 'aws-lambda';
import { Cause, Effect, Exit } from 'effect';

import { e2eBucketName, e2eFlociEndpoint } from './config';

export type Stage = 'inbox' | 'lead-sources' | 'leads';
export type Fault = {
  readonly stage: Stage;
  readonly method: string;
  readonly match?: string;
  readonly outcome: 'failure' | 'defect' | 'hang';
  readonly failures?: number;
  readonly error?: 'AuthenticationFailed' | 'OrderStoreTimedOut' | 'OrderStoreFailed';
};
export type Control = {
  readonly id: string;
  readonly faults: readonly Fault[];
  readonly shutdownStage?: Stage;
  readonly invalidConfigStage?: Stage;
};
export type Observation = {
  readonly kind: 'start' | 'response' | 'error' | 'attempt' | 'outcome' | 'log';
  readonly stage: Stage;
  readonly invocation: string;
  readonly at: number;
  readonly method?: string;
  readonly identity?: string;
  readonly attempt?: number;
  readonly value?: unknown;
};

type Invocation = { stage: Stage; control: Control; id: string; attempts: Map<string, number>; logs: Promise<void>[] };
const invocation = new AsyncLocalStorage<Invocation>();
export const hasInvalidConfiguration = () => {
  const current = invocation.getStore();
  return current !== undefined && current.control.invalidConfigStage === current.stage;
};
const s3 = new S3Client({ endpoint: e2eFlociEndpoint, forcePathStyle: true });

export async function observe(event: Omit<Observation, 'stage' | 'invocation' | 'at'>) {
  const current = invocation.getStore();
  if (!current) throw new Error('E2E adapter executed outside an invocation');
  await s3.send(
    new PutObjectCommand({
      Bucket: e2eBucketName(),
      Key: `_e2e/${current.control.id}/${current.id}/${randomUUID()}.json`,
      Body: JSON.stringify({ ...event, stage: current.stage, invocation: current.id, at: Date.now() }),
    })
  );
}

export function observeLog(value: unknown) {
  const current = invocation.getStore();
  if (!current) throw new Error('Missing E2E logging context');
  const pending = observe({ kind: 'log', value });
  void pending.catch(() => {});
  current.logs.push(pending);
}

/**
 * Wraps one call of a port method so the e2e test can break it and see it.
 *
 * Each call counts as an attempt per `method` and `identity` (a file key, a lead name) within the invocation.
 * The first fault of the control that matches the stage, the method, the identity and the attempt replaces `effect`:
 * `hang` never ends, `defect` dies, and `failure` fails with the error that `failure(fault)` makes.
 * Without a matching fault, `effect` runs as is.
 * Either way, the attempt and its exit go to the observation bucket for the test to read.
 */
export function instrument<A, E, R>(
  method: string,
  identity: string,
  effect: Effect.Effect<A, E, R>,
  failure: (fault: Fault) => E
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    const current = invocation.getStore();
    if (!current) return Effect.die(new Error('Missing E2E invocation context'));
    const key = `${method}:${identity}`;
    const attempt = (current.attempts.get(key) ?? 0) + 1;
    current.attempts.set(key, attempt);
    const fault = current.control.faults.find(
      (item) =>
        item.stage === current.stage &&
        item.method === method &&
        (item.match === undefined || identity.includes(item.match)) &&
        (item.failures === undefined || attempt <= item.failures)
    );
    const operation = !fault
      ? effect
      : fault.outcome === 'hang'
        ? Effect.never
        : fault.outcome === 'defect'
          ? Effect.die(new Error(`Injected ${current.stage} ${method} defect`))
          : Effect.fail(failure(fault));
    return Effect.promise(() => observe({ kind: 'attempt', method, identity, attempt })).pipe(
      Effect.andThen(operation),
      Effect.onExit((exit) =>
        Effect.promise(() =>
          observe({
            kind: 'outcome',
            method,
            identity,
            attempt,
            value: Exit.isSuccess(exit)
              ? { tag: 'Success' }
              : {
                  tag: 'Failure',
                  reasons: exit.cause.reasons.map((reason) =>
                    Cause.isFailReason(reason)
                      ? { tag: 'Fail', error: reason.error }
                      : Cause.isDieReason(reason)
                        ? { tag: 'Die', message: String(reason.defect) }
                        : { tag: 'Interrupt' }
                  ),
                },
          })
        )
      )
    );
  });
}

export function wrap<A>(stage: Stage, handler: (event: SQSEvent, context: Context) => Promise<A>) {
  return async (event: SQSEvent, context: Context): Promise<A> => {
    let control: Control;
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: e2eBucketName(), Key: '_e2e/control.json' }));
      control = JSON.parse(await response.Body!.transformToString()) as Control;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'NoSuchKey') throw error;
      control = { id: 'deployment', faults: [] };
    }
    return invocation.run({ stage, control, id: randomUUID(), attempts: new Map(), logs: [] }, async () => {
      await observe({ kind: 'start', value: event });
      try {
        const result = await handler(
          event,
          control.shutdownStage === stage ? { ...context, getRemainingTimeInMillis: () => 250 } : context
        );
        await Promise.all(invocation.getStore()!.logs);
        await observe({ kind: 'response', value: result });
        return result;
      } catch (error) {
        await Promise.all(invocation.getStore()!.logs);
        await observe({ kind: 'error', value: { message: String(error) } });
        throw error;
      }
    });
  };
}
