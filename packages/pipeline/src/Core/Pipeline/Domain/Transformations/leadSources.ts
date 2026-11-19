import {
  LEAD_SOURCE_HEADER__BUSINESS_CLOSURE,
  LeadFromRow_BusinessClosure,
} from '@leads/shared/domain/sources/BusinessClosure';
import { LEAD_SOURCE_HEADER__MUTATION, LeadFromRow_Mutation } from '@leads/shared/domain/sources/Mutation';
import {
  LEAD_SOURCE_HEADER__NEW_ACQUISITION,
  LeadFromRow_NewAcquisition,
} from '@leads/shared/domain/sources/NewAcquisition';
import type { ExcelSheet, Lead } from '@leads/shared/domain/types';
import { Effect, Schema } from 'effect';

import { UnknownLeadsSource } from '#Core/Pipeline/Domain/Exceptions/UnknownLeadsSource';

type LeadSource = {
  readonly header: ReadonlyArray<string>;
  readonly decodeRow: (row: object) => Effect.Effect<Lead, Schema.SchemaError>;
};

const LeadSources: ReadonlyArray<LeadSource> = [
  { header: LEAD_SOURCE_HEADER__BUSINESS_CLOSURE, decodeRow: Schema.decodeUnknownEffect(LeadFromRow_BusinessClosure) },
  { header: LEAD_SOURCE_HEADER__NEW_ACQUISITION, decodeRow: Schema.decodeUnknownEffect(LeadFromRow_NewAcquisition) },
  { header: LEAD_SOURCE_HEADER__MUTATION, decodeRow: Schema.decodeUnknownEffect(LeadFromRow_Mutation) },
];

const matchesHeader = (header: ReadonlyArray<string>, expected: ReadonlyArray<string>) =>
  header.length === expected.length && header.every((cell, index) => cell === expected[index]);

export const toLeadsAndRejectionsFromSheet = ({ header, rows }: ExcelSheet) =>
  Effect.gen(function* () {
    const source = LeadSources.find((candidate) => matchesHeader(header, candidate.header));
    if (source === undefined) {
      return yield* new UnknownLeadsSource({ header });
    }
    const [leads, leadRejections] = yield* Effect.partition(rows, (input, index) =>
      source.decodeRow(input).pipe(Effect.mapError((error) => ({ index, input, error })))
    );
    return { leads, leadRejections };
  });
