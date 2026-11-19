import { createServerFn } from '@tanstack/react-start';

import { handler, type StatusResult } from '#Core/Observation/Application/UseCases/ReadStatus/handler';
import { toWindowHours } from '#Core/Observation/Domain/time';

import { labServices } from './services.server';

export type { StatusResult };

/**
 * The HTTP adapter that reads one snapshot of the deployed workflow and assesses it. It only reads: it calls no AWS
 * operation that changes state. Each snapshot costs CloudWatch metric requests, so only a person starts a read.
 */
export const readStatus = createServerFn({ method: 'GET' })
  .validator((input: { readonly hours: number }) => ({ windowHours: toWindowHours(input.hours) }))
  .handler(({ data }): Promise<StatusResult> => handler(data, labServices()));
