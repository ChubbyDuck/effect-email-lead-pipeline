import path from 'node:path';

import { LEAD_SOURCE_HEADER__BUSINESS_CLOSURE } from '@leads/shared/domain/sources/BusinessClosure';
import { LEAD_SOURCE_HEADER__MUTATION } from '@leads/shared/domain/sources/Mutation';
import { LEAD_SOURCE_HEADER__NEW_ACQUISITION } from '@leads/shared/domain/sources/NewAcquisition';
import { type LeadSourceType, LeadSourceTypes } from '@leads/shared/domain/types';

import { generateBusinessClosureLead } from './businessClosure';
import { generateMutationLead } from './mutation';
import { generateNewAcquisitionLead } from './newAcquisition';

export const outputDirectory = path.resolve(import.meta.dirname, '../output/workbooks');

export const outputFile = (source: LeadSourceType) => path.join(outputDirectory, `${source}.xlsx`);

/** The header gives the column order of the workbook, which the sources handler matches exactly. */
export const generators = {
  business_closure: { header: LEAD_SOURCE_HEADER__BUSINESS_CLOSURE, generate: generateBusinessClosureLead },
  new_acquisition: { header: LEAD_SOURCE_HEADER__NEW_ACQUISITION, generate: generateNewAcquisitionLead },
  mutation: { header: LEAD_SOURCE_HEADER__MUTATION, generate: generateMutationLead },
} as const satisfies Record<
  LeadSourceType,
  { readonly header: readonly string[]; readonly generate: () => Record<string, unknown> }
>;

/** A comma-separated list. A name that is not a source is dropped, and an empty result means every source. */
export function parseSources(value: string | undefined): readonly LeadSourceType[] {
  const sources = (value ?? '')
    .split(',')
    .filter((source): source is LeadSourceType => LeadSourceTypes.includes(source as LeadSourceType));
  return sources.length === 0 ? LeadSourceTypes : sources;
}
