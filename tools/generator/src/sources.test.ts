import { toLeadsAndRejectionsFromSheet } from '@leads/pipeline/domain/Transformations/leadSources';
import { ExcelSheetParserLive } from '@leads/pipeline/infrastructure/ExcelSheetParser/live';
import { ExcelSheetParser } from '@leads/pipeline/ports/ExcelSheetParser';
import { LeadSourceTypes } from '@leads/shared/domain/types';
import { Effect } from 'effect';
import { expect, test } from 'vitest';

import { generators, parseSources } from './sources';
import { generate, toWorkbook } from './workbooks';

test('parseSources keeps the sources that it knows, in the given order', () => {
  expect(parseSources('mutation,business_closure')).toEqual(['mutation', 'business_closure']);
});

test('parseSources drops a name that is not a source', () => {
  expect(parseSources('mutation,unknown')).toEqual(['mutation']);
});

test.each([undefined, '', 'unknown'])('parseSources returns every source for %j', (value) => {
  expect(parseSources(value)).toEqual(LeadSourceTypes);
});

test.each(LeadSourceTypes)('the workbook of %s holds leads that the pipeline accepts', async (source) => {
  const buffer = toWorkbook(source, generate(25, generators[source].generate));

  const { leads, leadRejections } = await Effect.runPromise(
    Effect.gen(function* () {
      const parser = yield* ExcelSheetParser;
      return yield* toLeadsAndRejectionsFromSheet(yield* parser.parse(buffer));
    }).pipe(Effect.provide(ExcelSheetParserLive))
  );

  expect(leadRejections).toEqual([]);
  expect(leads).toHaveLength(25);
  expect(new Set(leads.map((lead) => lead.extraction_source))).toEqual(new Set([source]));
});
