import { runsMatching } from '#Core/Observation/Application/runs';
import { type DlqCause, pickRun } from '#Core/Observation/Domain/dlq';
import type { LogSearch } from '#Core/Observation/Ports/LogSearch';

import type { Command } from './command';

export type Ports = {
  readonly logs: LogSearch;
};

/** In ms. The search starts before the receive, for the lines of a cold start, and ends after the handler timeout. */
const causeMarginMs = 60_000;
/** The texts of the lines of a run that failed: an error of the handler or of the runtime, a timeout, or a failed `REPORT`. */
const failureTerms = ['ERROR', 'Task timed out', 'Status: error', 'Status: timeout'];

/**
 * Finds the run that failed a message of a DLQ, from the logs. First it searches for the message ID, which the handler
 * logs when the message goes to the DLQ. A message that went to the DLQ before that line, or after a timeout, has no
 * such line. Then it picks the failed run of each request of the message, in turn, that started nearest to the receive.
 * A run can fail before it logs its request, so last it picks from all the failed runs that started near the receive.
 */
export async function handler(
  { stage, messageId, receivedAt, requestIDs }: Command,
  { logs }: Ports
): Promise<DlqCause> {
  const { logGroup, timeoutSeconds } = await logs.handlerOf(stage);
  const from = new Date(receivedAt.getTime() - causeMarginMs);
  const to = new Date(receivedAt.getTime() + timeoutSeconds * 1000 + causeMarginMs);
  const cause = {
    messageId,
    deployment: logs.deployment,
    region: logs.region,
    logGroup,
    from: from.toISOString(),
    to: to.toISOString(),
  };
  const runsOf = (terms: readonly string[], requestID = requestIDs[0] ?? '') =>
    runsMatching(logs, { stage, logGroup, terms, requestID, from, to }).then(({ runs }) => runs);

  // Only the run that took the message names it, so its start time does not matter.
  const named = await runsOf([messageId]);
  const exact = pickRun(named, receivedAt.getTime()) ?? (named[0] && { run: named[0], candidates: named.length });
  if (exact !== undefined) return { ...cause, found: { basis: { kind: 'message' }, ...exact } };

  for (const requestID of requestIDs) {
    const picked = pickRun(await runsOf([requestID], requestID), receivedAt.getTime());
    if (picked !== undefined) return { ...cause, found: { basis: { kind: 'request', requestID }, ...picked } };
  }

  const picked = pickRun(await runsOf(failureTerms), receivedAt.getTime());
  return picked === undefined ? cause : { ...cause, found: { basis: { kind: 'time' }, ...picked } };
}
