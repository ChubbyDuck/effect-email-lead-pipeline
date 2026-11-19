import {
  type AppConfigDataClient,
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from '@aws-sdk/client-appconfigdata';
import { Config, ConfigProvider, Duration, Effect, Exit } from 'effect';

/** The AppConfig profile that holds the runtime settings. The stack sets these IDs on each handler. */
export const RuntimeSettingsSource = Config.all({
  application: Config.String('APPCONFIG_APPLICATION_ID'),
  environment: Config.String('APPCONFIG_ENVIRONMENT_ID'),
  profile: Config.String('APPCONFIG_PROFILE_ID'),
});

/** AppConfig refuses a poll that comes sooner than this after the previous poll of the same session. */
export const minimumPollInterval = Duration.seconds(15);

const unreadable = (cause: unknown) =>
  new ConfigProvider.SourceError({ message: 'AWS AppConfig did not return the runtime settings', cause });

/**
 * Reads the runtime settings document. AppConfig sends a document only when it changed, so the poll keeps the
 * last one. After a failure, the poll starts a new session, and the last document stays in use. A failure
 * before the first document is a `SourceError`.
 */
export const makeRuntimeSettingsPoll = (client: AppConfigDataClient) => {
  let token: string | undefined;
  let document: unknown;

  const poll = Effect.gen(function* () {
    const source = yield* RuntimeSettingsSource.pipe(Effect.mapError(unreadable));
    return yield* Effect.tryPromise({
      try: async (abortSignal) => {
        token ??= (
          await client.send(
            new StartConfigurationSessionCommand({
              ApplicationIdentifier: source.application,
              EnvironmentIdentifier: source.environment,
              ConfigurationProfileIdentifier: source.profile,
              RequiredMinimumPollIntervalInSeconds: Duration.toSeconds(minimumPollInterval),
            }),
            { abortSignal }
          )
        ).InitialConfigurationToken;
        const response = await client.send(new GetLatestConfigurationCommand({ ConfigurationToken: token }), {
          abortSignal,
        });
        token = response.NextPollConfigurationToken;
        // When the document did not change, the SDK gives `null`, not the `undefined` that its type declares.
        if (response.Configuration != null && response.Configuration.length > 0) {
          document = JSON.parse(new TextDecoder().decode(response.Configuration));
        }
        if (document === undefined) throw new Error('AppConfig has no deployed runtime settings');
        return document;
      },
      catch: (cause) => {
        token = undefined;
        return unreadable(cause);
      },
    });
  });

  return poll.pipe(
    Effect.catch((error) =>
      document === undefined
        ? Effect.fail(error)
        : Effect.logWarning('Runtime settings are stale', error.cause).pipe(Effect.as(document))
    )
  );
};

/**
 * Puts the AppConfig document in front of the current provider, so a setting that is not in the document still
 * comes from the environment. Each build reads the cached poll, so each handler run sees the latest settings.
 */
export const makeRuntimeSettingsLive = (client: AppConfigDataClient, refresh: Duration.Input = '30 seconds') => {
  const cached = Effect.runSync(
    Effect.cachedWithTTL(makeRuntimeSettingsPoll(client), (exit) => (Exit.isSuccess(exit) ? refresh : 0))
  );
  return ConfigProvider.layerAdd(Effect.map(cached, ConfigProvider.fromUnknown), { asPrimary: true });
};
