import { sources } from '@leads/pipeline/testing/workbooks';
import { utils, write } from 'xlsx';

export type SourceName = (typeof sources)[number]['name'];
export const sourceNames = sources.map((source) => source.name);

const dateLike = /^\d{2}[-/]\d{2}[-/]\d{2,4}$/;

/** Every column filled and every row unique, so the sheet is as large as a real export of this type. */
const rowAt = (header: readonly string[], template: Record<string, unknown>, index: number) =>
  header.map((column) => {
    const value = template[column];
    if (value === undefined) return `${column} ${index}`;
    if (typeof value === 'string' && !dateLike.test(value)) return `${value} ${index}`;
    return value;
  });

/** A compressed `.xlsx`, as Excel writes it. */
export function makeWorkbook(sourceName: SourceName, rows: number): Buffer {
  const source = sources.find((candidate) => candidate.name === sourceName);
  if (source === undefined) throw new Error(`Unknown source ${sourceName}`);
  const header = [...source.header] as string[];
  const template = source.rows[0] as Record<string, unknown>;
  const sheet = utils.aoa_to_sheet([
    header,
    ...Array.from({ length: rows }, (_, index) => rowAt(header, template, index)),
  ]);
  const book = utils.book_new();
  utils.book_append_sheet(book, sheet, 'Leads');
  return write(book, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
}
