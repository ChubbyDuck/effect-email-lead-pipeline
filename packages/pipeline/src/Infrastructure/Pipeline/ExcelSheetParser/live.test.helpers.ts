import { Buffer } from 'node:buffer';

import type { ExcelSheet } from '@leads/shared/domain/types';
import { Effect } from 'effect';
import { utils, write } from 'xlsx';

import { ExcelSheetParser } from '#Core/Pipeline/Ports/ExcelSheetParser';

import { ExcelSheetParserLive } from './live';

export const utf8 = (value: string): Buffer => Buffer.from(value);

const worksheet = (rows: readonly (readonly unknown[])[]) => utils.aoa_to_sheet(rows.map((row) => [...row]));

export const workbook = (...sheets: readonly (readonly (readonly unknown[])[])[]): Buffer => {
  const book = utils.book_new();
  for (const [index, rows] of sheets.entries()) {
    utils.book_append_sheet(book, worksheet(rows), `Sheet${index + 1}`);
  }
  return Buffer.from(write(book, { type: 'buffer', bookType: 'xlsx' }));
};

const parse = (buffer: Buffer) =>
  Effect.gen(function* () {
    const parser = yield* ExcelSheetParser;
    return yield* parser.parse(buffer);
  }).pipe(Effect.provide(ExcelSheetParserLive));

export const parseSheet = (buffer: Buffer): Promise<ExcelSheet> => Effect.runPromise(parse(buffer));

export const parseError = (buffer: Buffer) => Effect.runPromise(parse(buffer).pipe(Effect.flip));
