import { readRequest, type RequestPorts } from '#Core/Observation/Application/request';
import { type DetailsResult, requestDetailsOf } from '#Core/Observation/Domain/details';

import type { Command } from './command';

export type Ports = RequestPorts;

/** Reads the entry of a request and its runs, and gives the details of the request for its sheet. */
export async function handler(ports: Ports, { requestID, now }: Command): Promise<DetailsResult> {
  const read = await readRequest(ports, requestID, now);
  return read.ok ? { ok: true, details: requestDetailsOf(read.entry, read.runs) } : read;
}
