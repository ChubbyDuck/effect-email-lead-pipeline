import type { Agent } from 'node:http';

import { LeadSourcesInternalConcurrency } from '@leads/pipeline/settings';
import { handlerSettings } from '@leads/shared/domain/handlerSettings';
import { ConfigProvider, Effect } from 'effect';
import { expect, test } from 'vitest';

import { makeLeadSourcesSqsClient } from './leadSourcesSqs';

type ResolvedHandlerConfig = { httpsAgent: Agent; httpAgentProvider: () => Promise<Agent> };

// The SDK resolves the handler options lazily; `configProvider` holds the agents it makes.
const agentsOf = async (client: ReturnType<typeof makeLeadSourcesSqsClient>) => {
  const handler = client.config.requestHandler as unknown as { configProvider: Promise<ResolvedHandlerConfig> };
  const config = await handler.configProvider;
  return { httpsAgent: config.httpsAgent, httpAgent: await config.httpAgentProvider() };
};

const concurrencyFrom = (provider: ConfigProvider.ConfigProvider) =>
  Effect.runSync(LeadSourcesInternalConcurrency.pipe(Effect.provide(ConfigProvider.layer(provider))));

test('defaults the batch sends at once to the burst simulator src_c', () => {
  expect(concurrencyFrom(ConfigProvider.fromEnv({ env: {} }))).toBe(handlerSettings.internalConcurrency.leadSources);
  expect(concurrencyFrom(ConfigProvider.fromEnv({ env: { LEAD_SOURCES_INTERNAL_CONCURRENCY: '7' } }))).toBe(7);
});

test('opens one keep-alive socket per batch send on both the HTTPS and the HTTP agent', async () => {
  const client = makeLeadSourcesSqsClient(handlerSettings.internalConcurrency.leadSources, 'http://floci:4566');
  const { httpAgent, httpsAgent } = await agentsOf(client);

  expect(httpsAgent.maxSockets).toBe(200);
  expect(httpAgent.maxSockets).toBe(200);
  expect(httpsAgent).toMatchObject({ options: { keepAlive: true } });
  expect(httpAgent).toMatchObject({ options: { keepAlive: true } });
  expect(client.config.useQueueUrlAsEndpoint).toBe(false);
});
