import type { Buffer, ExcelSheet } from '@leads/shared/domain/types';
import { Context, Data, type Effect } from 'effect';

export class ExcelSheetNotParsed extends Data.TaggedError('ExcelSheetNotParsed')<{
  readonly reason: unknown;
}> {
  override readonly message = 'Excel sheet cannot be parsed';
}

export class NotAnExcelDocument extends Data.TaggedError('NotAnExcelDocument') {
  override readonly message = 'Invalid file type. Please provide an .xlsx file';
}

export class WorkbookHasNoSheets extends Data.TaggedError('WorkbookHasNoSheets') {
  readonly layer = 'infra' as const;
  override readonly message = 'Workbook has no sheets';
}

export class ExcelSheetParser extends Context.Service<
  ExcelSheetParser,
  {
    readonly parse: (
      buffer: Buffer
    ) => Effect.Effect<ExcelSheet, NotAnExcelDocument | WorkbookHasNoSheets | ExcelSheetNotParsed>;
  }
>()('@leads/pipeline/Core/Pipeline/Ports/ExcelSheetParser') {}
