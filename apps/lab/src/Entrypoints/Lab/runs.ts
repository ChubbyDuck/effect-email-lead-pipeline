import { createServerFn } from '@tanstack/react-start';

import { handler as readRunsOf } from '#Core/Observation/Application/UseCases/ReadRuns/handler';
import type { DetailsResult } from '#Core/Observation/Domain/details';

import { labServices } from './services.server';

/** The shape of a request ID. The ID goes into a filter pattern of CloudWatch Logs, so it must have no quote. */
const requestIDShape = /^[a-z0-9]{1,128}$/;

function toQuery({ requestID }: { readonly requestID: string }) {
  if (!requestIDShape.test(requestID)) throw new Error(`Not a request ID: ${requestID}`);
  return { requestID };
}

/**
 * The HTTP adapter that reads the details of one request: its ledger entry and its Lambda runs. It only reads. Each
 * read costs a DynamoDB read and some CloudWatch Logs requests, so only a person starts a read.
 */
export const readRuns = createServerFn({ method: 'GET' })
  .validator(toQuery)
  .handler(async ({ data }): Promise<DetailsResult> => {
    try {
      const services = labServices();
      return await readRunsOf(
        { entries: services, logs: services.logs },
        { requestID: data.requestID, now: Date.now() }
      );
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
