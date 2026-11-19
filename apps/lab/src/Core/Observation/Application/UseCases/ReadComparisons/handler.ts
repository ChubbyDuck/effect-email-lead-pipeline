import { readRequest, type RequestPorts } from '#Core/Observation/Application/request';
import type { ComparisonResult, RequestRead } from '#Core/Observation/Domain/comparison';

import type { Command } from './command';

export type Ports = RequestPorts;

/**
 * The most requests that read at the same time. Each read does at least six log searches at once, and the quota of the
 * log searches is low, so more reads at one time only make more of them wait in retries.
 */
export const readLimit = 2;

/** Reads the entry and the runs of each request, for the burst simulator. CompareRequest calculates each comparison. */
export async function handler(ports: Ports, { requestIDs, now }: Command): Promise<readonly RequestRead[]> {
  const results: ComparisonResult[] = [];
  let next = 0;
  async function reader() {
    while (next < requestIDs.length) {
      const index = next++;
      results[index] = await readRequest(ports, requestIDs[index]!, now).catch(
        (error: unknown): ComparisonResult => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(readLimit, requestIDs.length) }, reader));
  return requestIDs.map((requestID, index) => ({ requestID, result: results[index]! }));
}
