import { workbook } from '@leads/pipeline/testing/workbooks';
import type { LeadSourceType } from '@leads/shared/domain/types';

import { generators } from './sources';

export function generate<Lead>(amount: number, generator: () => Lead) {
  return Array.from({ length: amount }, generator);
}

/** The columns follow the header of the source, so the sources handler can tell which source the workbook is. */
export function toWorkbook(source: LeadSourceType, leads: readonly Record<string, unknown>[]) {
  return workbook(generators[source].header, leads);
}

export function parseAmount(value: string | undefined) {
  const amount = Number(value);
  if (value === undefined || !Number.isInteger(amount) || amount < 1) {
    throw new Error(`The number of leads must be a whole number of 1 or more. Got: ${value ?? 'nothing'}`);
  }
  return amount;
}
