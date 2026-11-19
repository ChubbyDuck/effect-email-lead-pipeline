import { stageNames, type StageName } from '@leads/shared/domain/stages';
import { createServerFn } from '@tanstack/react-start';

import { handler as readDeadLetterCause } from '#Core/Observation/Application/UseCases/ReadDeadLetterCause/handler';
import { handler as readDeadLetters } from '#Core/Observation/Application/UseCases/ReadDeadLetters/handler';
import { handler as redriveDeadLetter } from '#Core/Observation/Application/UseCases/RedriveDeadLetter/handler';
import type { CauseInput, CauseQuery, DlqCauseResult, DlqResult, RedriveResult } from '#Core/Observation/Domain/dlq';

import { labServices } from './services.server';

function toStage(stage: string): StageName {
  if (!stageNames.includes(stage as StageName)) throw new Error(`Not a stage: ${stage}`);
  return stage as StageName;
}

const toQuery = ({ stage }: { readonly stage: string }) => ({ stage: toStage(stage) });

/** The shapes of the IDs. Each ID goes into a filter pattern of CloudWatch Logs, so it must have no quote. */
const messageIdShape = /^[A-Za-z0-9-]{1,100}$/;
const requestIDShape = /^[a-z0-9]{1,128}$/;
/** The most requests of one message that the search tries. */
const requestLimit = 5;

function toCauseQuery({ stage, messageId, receivedAt, requestIDs }: CauseInput): CauseQuery {
  if (!messageIdShape.test(messageId)) throw new Error(`Not a message ID: ${messageId}`);
  const bad = requestIDs.find((requestID) => !requestIDShape.test(requestID));
  if (bad !== undefined) throw new Error(`Not a request ID: ${bad}`);
  const at = new Date(receivedAt);
  if (Number.isNaN(at.getTime())) throw new Error(`Not a time: ${receivedAt}`);
  return { stage: toStage(stage), messageId, receivedAt: at, requestIDs: requestIDs.slice(0, requestLimit) };
}

/**
 * The HTTP adapter that reads the messages of the DLQ of one stage. It does not delete a message or hide it from the
 * queue. Only a person starts a read.
 */
export const readDlq = createServerFn({ method: 'GET' })
  .validator(toQuery)
  .handler(async ({ data }): Promise<DlqResult> => {
    try {
      return { ok: true, dlq: await readDeadLetters(data, labServices()) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

/**
 * The HTTP adapter that finds the run that failed a message of a DLQ. It only reads. Each search costs some CloudWatch
 * Logs requests, so only a person starts a search.
 */
export const readDlqCause = createServerFn({ method: 'GET' })
  .validator(toCauseQuery)
  .handler(async ({ data }): Promise<DlqCauseResult> => {
    try {
      return { ok: true, cause: await readDeadLetterCause(data, labServices()) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

function toRedrive({ stage, messageId }: { readonly stage: string; readonly messageId: string }) {
  if (!messageIdShape.test(messageId)) throw new Error(`Not a message ID: ${messageId}`);
  return { stage: toStage(stage), messageId };
}

/**
 * The HTTP adapter that sends one message of a DLQ back to the main queue of its stage. Unlike the other adapters of
 * the lab, it changes state, so it takes only a POST, and only a person starts it.
 */
export const redriveDlqMessage = createServerFn({ method: 'POST' })
  .validator(toRedrive)
  .handler(async ({ data }): Promise<RedriveResult> => {
    try {
      return { ok: true, redriven: await redriveDeadLetter(data, labServices()) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
