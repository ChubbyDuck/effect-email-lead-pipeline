import { type Buffer, ExcelSheet } from '@leads/shared/domain/types';
import { Effect, Layer, Schema } from 'effect';
import { fileTypeFromBuffer } from 'file-type';
import * as XLSX from 'xlsx';

import {
  ExcelSheetNotParsed,
  ExcelSheetParser,
  NotAnExcelDocument,
  WorkbookHasNoSheets,
} from '#Core/Pipeline/Ports/ExcelSheetParser';

/**
 * The Office Open XML workbooks that the parser reads: `.xlsx`, and `.xlsm`, which newer versions of file-type tell apart from
 * `.xlsx`. The parser reads only the values of the cells, so it never runs a macro. A binary `.xlsb` is a plain
 * zip for file-type, so it is not an Excel document.
 */
const workbookTypes: ReadonlyArray<{ readonly ext: string; readonly mime: string }> = [
  { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { ext: 'xlsm', mime: 'application/vnd.ms-excel.sheet.macroenabled.12' },
];

const isXlsx = (buffer: Buffer) =>
  Effect.tryPromise({
    try: () => fileTypeFromBuffer(buffer),
    catch: (reason) => new ExcelSheetNotParsed({ reason }),
  }).pipe(
    Effect.map(
      (type) => type !== undefined && workbookTypes.some(({ ext, mime }) => ext === type.ext && mime === type.mime)
    )
  );

const readFirstSheet = (buffer: Buffer) =>
  Effect.try({
    try: () => XLSX.read(buffer, { cellDates: true }),
    catch: (reason) => new ExcelSheetNotParsed({ reason }),
  }).pipe(
    Effect.flatMap((workbook) => {
      const name = workbook.SheetNames[0];
      const sheet = name === undefined ? undefined : workbook.Sheets[name];
      return sheet === undefined ? Effect.fail(new WorkbookHasNoSheets()) : Effect.succeed(sheet);
    })
  );

const decodeSheet = Schema.decodeUnknownEffect(ExcelSheet);

const toExcelSheet = (sheet: XLSX.WorkSheet) =>
  decodeSheet({
    header: XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 })[0] ?? [],
    rows: XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet).map(({ __rowNum__, ...row }) => row),
  }).pipe(Effect.mapError((reason) => new ExcelSheetNotParsed({ reason })));

export const ExcelSheetParserLive = Layer.succeed(ExcelSheetParser, {
  parse: (buffer) =>
    Effect.gen(function* () {
      if (!(yield* isXlsx(buffer))) {
        return yield* new NotAnExcelDocument();
      }
      const sheet = yield* readFirstSheet(buffer);
      return yield* toExcelSheet(sheet);
    }),
});
