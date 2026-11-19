import { createServerFn } from '@tanstack/react-start';

import { handler as readComparisonsOf } from '#Core/Observation/Application/UseCases/ReadComparisons/handler';
import { comparisonLimit, type RequestRead } from '#Core/Observation/Domain/comparison';

import { labServices } from './services.server';

/** The shape of a request ID. The ID goes into a filter pattern of CloudWatch Logs, so it must have no quote. */
const requestIDShape = /^[a-z0-9]{1,128}$/;

function toQuery({ requestIDs }: { readonly requestIDs: readonly string[] }) {
  if (requestIDs.length > comparisonLimit) throw new Error(`Read at most ${comparisonLimit} requests at one time.`);
  return { requestIDs };
}

/**
 * The HTTP adapter that reads a list of requests for the burst simulator: the ledger entry and the Lambda runs of each.
 * It only reads. Each read costs a DynamoDB read and some CloudWatch Logs requests, so only a person starts a read. A
 * bad ID, or a failed read, fails only its own request.
 */
export const readComparisons = createServerFn({ method: 'GET' })
  .validator(toQuery)
  .handler(async ({ data }): Promise<readonly RequestRead[]> => {
    const { requestIDs } = data;
    try {
      const services = labServices();
      const reads = await readComparisonsOf(
        { entries: services, logs: services.logs },
        { requestIDs: requestIDs.filter((id) => requestIDShape.test(id)), now: Date.now() }
      );
      return requestIDs.map(
        (requestID) =>
          reads.find((read) => read.requestID === requestID) ?? {
            requestID,
            result: { ok: false, error: `Not a request ID: ${requestID}` },
          }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return requestIDs.map((requestID) => ({ requestID, result: { ok: false, error: message } }));
    }
  });
