import { ConfigProvider, Effect, Exit, Schema } from 'effect';
import { describe, expect, test } from 'vitest';

import { AppConfig, RuntimeSettings } from './config';
import { maxRetryDelay, minRetryDelay } from './retry';

const readConfig = (settings: Record<string, unknown>) =>
  Effect.runPromiseExit(
    AppConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ LEAD_SOURCES_BUCKET_NAME: 'lead-sources', ...settings }))
      )
    )
  );

describe('the retry delay', () => {
  test.each([0, minRetryDelay - 1, maxRetryDelay + 1])(
    'rejects %d ms in AppConfig and in the config',
    async (delay) => {
      expect(Schema.is(RuntimeSettings)({ LEAD_PROCESSING_RETRY_DELAY: delay })).toBe(false);
      expect(Exit.isFailure(await readConfig({ LEAD_PROCESSING_RETRY_DELAY: delay }))).toBe(true);
    }
  );

  test.each([minRetryDelay, maxRetryDelay])('accepts %d ms', async (delay) => {
    expect(Schema.is(RuntimeSettings)({ LEAD_PROCESSING_RETRY_DELAY: delay })).toBe(true);
    expect(await readConfig({ LEAD_PROCESSING_RETRY_DELAY: delay })).toMatchObject({
      value: { leadProcessingRetryDelay: delay },
    });
  });

  test('is 200 ms when no setting gives it', async () => {
    expect(await readConfig({})).toMatchObject({ value: { leadProcessingRetryDelay: 200 } });
  });
});
