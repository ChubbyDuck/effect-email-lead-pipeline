import { expect, test } from 'vitest';

import { ExcelSheetNotParsed, NotAnExcelDocument } from '#Core/Pipeline/Ports/ExcelSheetParser';

import { parseError, parseSheet, utf8, workbook } from './live.test.helpers';

test('parses the header and rows of the first sheet', async () => {
  const opened = new Date(2024, 0, 15);
  const sheet = await parseSheet(
    workbook(
      [
        ['Name', 'Gültig ab'],
        ['Acme', opened],
        ['Beta', ''],
      ],
      [['Other']]
    )
  );

  expect(sheet).toEqual({
    header: ['Name', 'Gültig ab'],
    rows: [
      { Name: 'Acme', 'Gültig ab': opened },
      { Name: 'Beta', 'Gültig ab': '' },
    ],
  });
  expect(sheet.rows.every((row) => !('__rowNum__' in row))).toBe(true);
});

test('returns the header and no rows when the sheet has no data rows', async () => {
  const sheet = await parseSheet(workbook([['Name', 'City']]));

  expect(sheet).toEqual({ header: ['Name', 'City'], rows: [] });
});

test('returns an empty header and no rows for an empty sheet', async () => {
  const sheet = await parseSheet(workbook([]));

  expect(sheet).toEqual({ header: [], rows: [] });
});

test('fails with NotAnExcelSheet when the file body is not an xlsx file', async () => {
  const error = await parseError(utf8('Lorem ipsum dolor sit amet.'));

  expect(error).toBeInstanceOf(NotAnExcelDocument);
  expect(error.message).toBe('Invalid file type. Please provide an .xlsx file');
});

test('fails with ExcelSheetNotParsed when the workbook cannot be read', async () => {
  const error = await parseError(workbook([['Name'], ['Acme']]).subarray(0, 80));

  expect(error).toBeInstanceOf(ExcelSheetNotParsed);
  expect(error).toMatchObject({
    message: 'Excel sheet cannot be parsed',
    reason: { message: 'Unsupported ZIP file' },
  });
});

test('fails with ExcelSheetNotParsed when the header is not strings', async () => {
  const error = await parseError(workbook([[1, 2], [3]]));

  expect(error).toBeInstanceOf(ExcelSheetNotParsed);
  expect(error).toMatchObject({ message: 'Excel sheet cannot be parsed' });
});
