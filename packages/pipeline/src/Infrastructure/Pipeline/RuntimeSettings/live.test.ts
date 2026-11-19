import {
  type AppConfigDataClient,
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from '@aws-sdk/client-appconfigdata';
import { Config, ConfigProvider, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, test } from 'vitest';

import { makeRuntimeSettingsLive } from './live';

const source = {
  APPCONFIG_APPLICATION_ID: 'application',
  APPCONFIG_ENVIRONMENT_ID: 'environment',
  APPCONFIG_PROFILE_ID: 'profile',
};

type Reply = { readonly document?: unknown } | { readonly error: string };

/**
 * Answers each poll with the next reply. Each token is valid once, the same as in AppConfig. A reply without a
 * document gives `Configuration: null`, the same as the real SDK when the document did not change.
 */
function makeClient(replies: Reply[]) {
  const calls: string[] = [];
  let sessions = 0;
  let polls = 0;
  let valid: string | undefined;
  const send = async (command: unknown) => {
    if (command instanceof StartConfigurationSessionCommand) {
      sessions++;
      calls.push(`start ${command.input.ApplicationIdentifier}/${command.input.EnvironmentIdentifier}`);
      valid = `session-${sessions}-0`;
      return { InitialConfigurationToken: valid };
    }
    if (!(command instanceof GetLatestConfigurationCommand)) throw new Error('Unexpected command');
    const token = command.input.ConfigurationToken;
    calls.push(`poll ${token}`);
    if (token !== valid) throw new Error('Invalid configuration token');
    const reply = replies[polls++] ?? {};
    if ('error' in reply) throw new Error(reply.error);
    valid = `session-${sessions}-${polls}`;
    return {
      NextPollConfigurationToken: valid,
      Configuration: reply.document === undefined ? null : new TextEncoder().encode(JSON.stringify(reply.document)),
    };
  };
  return { client: { send } as unknown as AppConfigDataClient, calls };
}

/** A read fails when the config does not decode, or when the source of the config fails. */
type ReadFailure = Config.ConfigError | ConfigProvider.SourceError;

/** Builds the layer for each read, the same as a handler that provides its services for each message. */
function run<A, E>(
  client: AppConfigDataClient,
  program: (readOnce: <B>(config: Config.Config<B>) => Effect.Effect<B, ReadFailure>) => Effect.Effect<A, E>
) {
  const live = makeRuntimeSettingsLive(client);
  const environment = ConfigProvider.layer(ConfigProvider.fromUnknown({ ...source, FROM_ENV: 'env', SHARED: 'env' }));
  const readOnce = <B>(config: Config.Config<B>) => config.pipe(Effect.provide(live.pipe(Layer.provide(environment))));
  return Effect.runPromiseExit(program(readOnce).pipe(Effect.provide(TestClock.layer())));
}

test('puts the AppConfig document in front of the environment', async () => {
  const { client, calls } = makeClient([{ document: { SHARED: 'appconfig' } }]);

  const exit = await run(client, (readOnce) =>
    Effect.all([readOnce(Config.String('SHARED')), readOnce(Config.String('FROM_ENV'))])
  );

  expect(exit).toMatchObject({ _tag: 'Success', value: ['appconfig', 'env'] });
  expect(calls).toEqual(['start application/environment', 'poll session-1-0']);
});

test('polls again after the refresh and keeps the last document when AppConfig sends no change', async () => {
  const { client, calls } = makeClient([{ document: { SHARED: 'first' } }, {}, { document: { SHARED: 'second' } }]);

  const exit = await run(client, (readOnce) =>
    Effect.gen(function* () {
      const values = [yield* readOnce(Config.String('SHARED'))];
      yield* TestClock.adjust('29 seconds');
      values.push(yield* readOnce(Config.String('SHARED')));
      yield* TestClock.adjust('1 second');
      values.push(yield* readOnce(Config.String('SHARED')));
      yield* TestClock.adjust('30 seconds');
      values.push(yield* readOnce(Config.String('SHARED')));
      return values;
    })
  );

  expect(exit).toMatchObject({ _tag: 'Success', value: ['first', 'first', 'first', 'second'] });
  expect(calls).toEqual(['start application/environment', 'poll session-1-0', 'poll session-1-1', 'poll session-1-2']);
});

test('keeps the last document after a failure and starts a new session on the next poll', async () => {
  const { client, calls } = makeClient([
    { document: { SHARED: 'first' } },
    { error: 'AppConfig is down' },
    { document: { SHARED: 'second' } },
  ]);

  const exit = await run(client, (readOnce) =>
    Effect.gen(function* () {
      const values = [yield* readOnce(Config.String('SHARED'))];
      yield* TestClock.adjust('30 seconds');
      values.push(yield* readOnce(Config.String('SHARED')));
      yield* TestClock.adjust('30 seconds');
      values.push(yield* readOnce(Config.String('SHARED')));
      return values;
    })
  );

  expect(exit).toMatchObject({ _tag: 'Success', value: ['first', 'first', 'second'] });
  expect(calls).toEqual([
    'start application/environment',
    'poll session-1-0',
    'poll session-1-1',
    'start application/environment',
    'poll session-2-0',
  ]);
});

test('fails with a SourceError until AppConfig sends the first document, then tries again at once', async () => {
  const { client, calls } = makeClient([{ error: 'AppConfig is down' }, {}, { document: { SHARED: 'first' } }]);

  const exit = await run(client, (readOnce) =>
    Effect.gen(function* () {
      const failures = [
        yield* Effect.flip(readOnce(Config.String('SHARED'))),
        yield* Effect.flip(readOnce(Config.String('SHARED'))),
      ];
      return { failures, value: yield* readOnce(Config.String('SHARED')) };
    })
  );

  expect(exit).toMatchObject({
    _tag: 'Success',
    value: { failures: [{ _tag: 'SourceError' }, { _tag: 'SourceError' }], value: 'first' },
  });
  expect(calls).toEqual([
    'start application/environment',
    'poll session-1-0',
    'start application/environment',
    'poll session-2-0',
    'start application/environment',
    'poll session-3-0',
  ]);
});

test('fails with a SourceError when the environment does not name the AppConfig profile', async () => {
  const { client, calls } = makeClient([]);
  const live = makeRuntimeSettingsLive(client);

  const exit = await Effect.runPromiseExit(
    Config.String('SHARED').pipe(
      Effect.provide(live.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ SHARED: 'env' })))))
    )
  );

  expect(exit).toMatchObject({ _tag: 'Failure', cause: { reasons: [{ error: { _tag: 'SourceError' } }] } });
  expect(calls).toEqual([]);
});
