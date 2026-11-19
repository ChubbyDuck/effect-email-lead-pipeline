import { randomUUID } from 'node:crypto';

import {
  AppConfigClient,
  CreateApplicationCommand,
  CreateConfigurationProfileCommand,
  CreateDeploymentStrategyCommand,
  CreateEnvironmentCommand,
  CreateHostedConfigurationVersionCommand,
  StartDeploymentCommand,
} from '@aws-sdk/client-appconfig';
import { AppConfigDataClient } from '@aws-sdk/client-appconfigdata';
import { ConfigProvider, Effect, Layer } from 'effect';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { AppConfig } from '#Core/Pipeline/Application/config';
import { InboxSenderWhitelist } from '#Core/Pipeline/Ports/Guard';

import { makeRuntimeSettingsLive } from './live';

const client = {
  endpoint: process.env.FLOCI_ENDPOINT ?? 'http://127.0.0.1:4566',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};
const appConfig = new AppConfigClient(client);
const appConfigData = new AppConfigDataClient(client);

let ids: { application: string; environment: string; profile: string; strategy: string };

/** Floci does not run AppConfig validators, so this test sends only documents that the validator accepts. */
async function deploy(document: unknown) {
  const version = await appConfig.send(
    new CreateHostedConfigurationVersionCommand({
      ApplicationId: ids.application,
      ConfigurationProfileId: ids.profile,
      ContentType: 'application/json',
      Content: new TextEncoder().encode(JSON.stringify(document)),
    })
  );
  await appConfig.send(
    new StartDeploymentCommand({
      ApplicationId: ids.application,
      EnvironmentId: ids.environment,
      ConfigurationProfileId: ids.profile,
      ConfigurationVersion: String(version.VersionNumber),
      DeploymentStrategyId: ids.strategy,
    })
  );
}

beforeAll(async () => {
  const { Id: application } = await appConfig.send(new CreateApplicationCommand({ Name: `leads-${randomUUID()}` }));
  const { Id: environment } = await appConfig.send(
    new CreateEnvironmentCommand({ ApplicationId: application, Name: 'test' })
  );
  const { Id: profile } = await appConfig.send(
    new CreateConfigurationProfileCommand({
      ApplicationId: application,
      Name: 'runtime-settings',
      LocationUri: 'hosted',
      Type: 'AWS.Freeform',
    })
  );
  const { Id: strategy } = await appConfig.send(
    new CreateDeploymentStrategyCommand({
      Name: `instant-${randomUUID()}`,
      DeploymentDurationInMinutes: 0,
      GrowthFactor: 100,
      FinalBakeTimeInMinutes: 0,
      ReplicateTo: 'NONE',
    })
  );
  if (!application || !environment || !profile || !strategy) throw new Error('Floci did not return AppConfig IDs');
  ids = { application, environment, profile, strategy };
});

afterAll(() => {
  appConfig.destroy();
  appConfigData.destroy();
});

test('reads the deployed settings in front of the environment and sees a new deployment on the next refresh', async () => {
  await deploy({ LEAD_INTERNAL_CONCURRENCY: 20, INBOX_SENDER_WHITELIST: ['first@example.org'] });
  const live = makeRuntimeSettingsLive(appConfigData, 0).pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          APPCONFIG_APPLICATION_ID: ids.application,
          APPCONFIG_ENVIRONMENT_ID: ids.environment,
          APPCONFIG_PROFILE_ID: ids.profile,
          LEAD_SOURCES_BUCKET_NAME: 'lead-sources',
          LEAD_INTERNAL_CONCURRENCY: 5,
        })
      )
    )
  );
  const settings = Effect.gen(function* () {
    const config = yield* AppConfig;
    return {
      leadSourcesBucketName: config.leadSourcesBucketName,
      leadInternalConcurrency: config.leadInternalConcurrency,
      whitelist: yield* InboxSenderWhitelist,
    };
  }).pipe(Effect.provide(live));

  const first = await Effect.runPromise(settings);
  await deploy({ LEAD_INTERNAL_CONCURRENCY: 30, INBOX_SENDER_WHITELIST: ['second@example.org'] });
  const second = await Effect.runPromise(settings);

  expect(first).toEqual({
    leadSourcesBucketName: 'lead-sources',
    leadInternalConcurrency: 20,
    whitelist: ['first@example.org'],
  });
  expect(second).toEqual({
    leadSourcesBucketName: 'lead-sources',
    leadInternalConcurrency: 30,
    whitelist: ['second@example.org'],
  });
});
