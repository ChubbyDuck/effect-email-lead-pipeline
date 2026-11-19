import { handlerTimeouts } from '@leads/shared/domain/handlerTimeouts';
import { Config, JsonSchema, Schema } from 'effect';

import { maxRetryDelay, minRetryDelay } from '#Core/Pipeline/Application/retry';
import { SenderAddress } from '#Core/Pipeline/Ports/Guard';

const between = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }));

const Concurrency = between(1, 1000);
const Retry = between(0, 10);
/** In ms. The wait before the first retry. */
const RetryDelay = between(minRetryDelay, maxRetryDelay);
/** In ms. A lead must time out before its handler does. */
const LeadTimeout = between(1, handlerTimeouts.lead - 1);

/**
 * The document of runtime settings in AWS AppConfig. A setting that is not in the document comes from the
 * environment, then from its default. The stack makes the AppConfig validator from this schema.
 */
export const RuntimeSettings = Schema.Struct({
  INBOX_INTERNAL_CONCURRENCY: Schema.optionalKey(Concurrency),
  LEAD_SOURCES_INTERNAL_CONCURRENCY: Schema.optionalKey(Concurrency),
  LEAD_INTERNAL_CONCURRENCY: Schema.optionalKey(Concurrency),
  LEAD_PROCESSING_RETRY: Schema.optionalKey(Retry),
  LEAD_PROCESSING_RETRY_DELAY: Schema.optionalKey(RetryDelay),
  LEAD_PROCESSING_TIMEOUT: Schema.optionalKey(LeadTimeout),
  INBOX_SENDER_WHITELIST: Schema.optionalKey(Schema.Array(SenderAddress)),
});

/**
 * The AppConfig validator for the runtime settings document. AppConfig supports only JSON Schema draft 4.
 * A key that the schema does not know is an error, so a misspelled setting cannot go live and do nothing.
 */
export function runtimeSettingsJsonSchema(): JsonSchema.JsonSchema {
  const document = JsonSchema.toDocumentDraft04(
    Schema.toJsonSchemaDocument(RuntimeSettings, { onExcessProperty: 'error' })
  );
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_04,
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 && { definitions: document.definitions }),
  };
}

/**
 * Fails the synthesis when the seed document is one that the validator would refuse. A function, so that the Lambda
 * bundles, which import this file for the handler settings, can leave it out.
 */
export const decodeRuntimeSettings = (document: unknown) =>
  Schema.decodeUnknownSync(RuntimeSettings, { onExcessProperty: 'error' })(document);

/** Batch sends at once in one lead-sources handler. The SQS client opens the same number of sockets. */
export const LeadSourcesInternalConcurrency = Config.schema(Concurrency, 'LEAD_SOURCES_INTERNAL_CONCURRENCY').pipe(
  Config.withDefault(200)
);

export const AppConfig = Config.all({
  leadSourcesBucketName: Config.String('LEAD_SOURCES_BUCKET_NAME'),
  leadsBatchCount: Config.Number('LEADS_PROCESSING_MAX_CONCURRENCY').pipe(Config.withDefault(250)),
  inboxInternalConcurrency: Config.schema(Concurrency, 'INBOX_INTERNAL_CONCURRENCY').pipe(Config.withDefault(50)),
  leadSourcesInternalConcurrency: LeadSourcesInternalConcurrency,
  leadInternalConcurrency: Config.schema(Concurrency, 'LEAD_INTERNAL_CONCURRENCY').pipe(Config.withDefault(10)),
  leadProcessingRetry: Config.schema(Retry, 'LEAD_PROCESSING_RETRY').pipe(Config.withDefault(3)),
  leadProcessingRetryDelay: Config.schema(RetryDelay, 'LEAD_PROCESSING_RETRY_DELAY').pipe(Config.withDefault(200)),
  leadProcessingTimeout: Config.schema(LeadTimeout, 'LEAD_PROCESSING_TIMEOUT').pipe(Config.withDefault(45 * 1000)),
});
