import { createServerFn } from '@tanstack/react-start';

import { handler } from '#Core/Observation/Application/UseCases/ReadLevels/handler';
import type { LevelsResult } from '#Core/Observation/Domain/levels';

import { labServices } from './services.server';

/**
 * The HTTP adapter that reads the levels of the pipeline: the counts of the queues and the objects of the buckets. It
 * only reads, and it requests no CloudWatch metric, so the page can poll it after a redrive.
 */
export const readLevels = createServerFn({ method: 'GET' }).handler(
  (): Promise<LevelsResult> => handler(labServices())
);
