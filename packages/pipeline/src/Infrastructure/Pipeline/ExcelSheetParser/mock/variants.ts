import { LEAD_SOURCE_HEADER__NEW_ACQUISITION } from '@leads/shared/domain/sources/NewAcquisition';
import type { ExcelSheet } from '@leads/shared/domain/types';
import { definePortMock } from '@leads/shared/testing/variants';
import { Effect } from 'effect';

import {
  ExcelSheetNotParsed,
  ExcelSheetParser,
  NotAnExcelDocument,
  WorkbookHasNoSheets,
} from '#Core/Pipeline/Ports/ExcelSheetParser';

const row = (name: string) => ({ Name: name, Ort: 'Zürich' });
const rejectedRow = { Name: 'K.A.', Ort: '.' };

const sheetWith = (...rows: object[]): ExcelSheet => ({ header: LEAD_SOURCE_HEADER__NEW_ACQUISITION, rows });

const excelSheetParserMock = definePortMock(ExcelSheetParser, ({ method, record, observation }) => {
  const parse = record('parse');

  return {
    variants: {
      parse: method('parse', {
        failsWithNotAnExcelDocument: (buffer) =>
          parse(buffer).pipe(Effect.andThen(Effect.fail(new NotAnExcelDocument()))),
        failsWithWorkbookHasNoSheets: (buffer) =>
          parse(buffer).pipe(Effect.andThen(Effect.fail(new WorkbookHasNoSheets()))),
        failsWithExcelSheetNotParsed: (buffer) =>
          parse(buffer).pipe(Effect.andThen(Effect.fail(new ExcelSheetNotParsed({ reason: 'corrupted' })))),
        succeedsWithUnknownHeader: (buffer) =>
          parse(buffer).pipe(Effect.andThen(Effect.succeed({ header: ['Unknown'], rows: [row('Acme')] }))),
        succeedsWithOnlyRejectedRows: (buffer) =>
          parse(buffer).pipe(Effect.andThen(Effect.succeed(sheetWith(rejectedRow, rejectedRow)))),
        succeedsWithRejectedRow: (buffer) =>
          parse(buffer).pipe(Effect.andThen(Effect.succeed(sheetWith(row('Acme'), rejectedRow)))),
        succeedsWithTwoLeads: (buffer) =>
          parse(buffer).pipe(Effect.andThen(Effect.succeed(sheetWith(row('Acme'), row('Broken'))))),
        succeedsWithElevenLeads: (buffer) =>
          parse(buffer).pipe(
            Effect.andThen(Effect.succeed(sheetWith(...Array.from({ length: 11 }, (_, index) => row(`Lead ${index}`)))))
          ),
        succeeds: (buffer) => parse(buffer).pipe(Effect.andThen(Effect.succeed(sheetWith(row('Acme'))))),
      }),
    },
    observation,
  };
});

export const excelSheetParserBuilder = excelSheetParserMock.builder;
export const makeExcelSheetParser = excelSheetParserMock.make;
