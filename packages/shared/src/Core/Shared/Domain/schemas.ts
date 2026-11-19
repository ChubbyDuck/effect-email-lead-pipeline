import { createHash } from 'node:crypto';

import { Effect, Schema, SchemaGetter, SchemaIssue } from 'effect';

export const formatLocalIsoDate = (date: Date): string => {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * The text of a cell of a workbook: a text as it is (an empty text too), a number, a boolean, or a bigint as `String`
 * writes it, and a date as its local ISO date, as `toIdempotencyKey` writes it. A missing cell (`null` or `undefined`)
 * and any other value, such as a rich-text object, have no text.
 */
export const cellText = (cell: unknown): string | undefined => {
  if (cell instanceof Date) return formatLocalIsoDate(cell);
  switch (typeof cell) {
    case 'string':
      return cell;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(cell);
    default:
      return undefined;
  }
};

export const CoercedStringWithoutNull = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value) => cellText(value) ?? ''),
    encode: SchemaGetter.passthrough({ strict: false }),
  })
);

export const optionalCoercedString = Schema.optionalKey(Schema.Union([Schema.Undefined, CoercedStringWithoutNull]));

export const ExcelCell = Schema.optionalKey(Schema.Unknown);

export const ExcelDateValue = Schema.Unknown.pipe(
  Schema.decode({
    decode: SchemaGetter.transform((value) => (value instanceof Date ? formatLocalIsoDate(value) : value)),
    encode: SchemaGetter.passthrough(),
  })
);

export const ExcelDateCell = Schema.optionalKey(ExcelDateValue);

const SanitizedCell = Schema.Union([Schema.String, Schema.Date]);

const SanitizedValue = Schema.Unknown.pipe(
  Schema.decodeTo(SanitizedCell, {
    decode: SchemaGetter.transform((value) => {
      if (value === undefined || value === null || value === 'K.A.' || value === '.') return '';
      if (value instanceof Date) return value;
      return (cellText(value) ?? '').trim();
    }),
    encode: SchemaGetter.passthrough({ strict: false }),
  })
);

const SanitizedLead = Schema.Record(Schema.String, SanitizedCell);

export const sanitizer = Schema.Record(Schema.String, SanitizedValue).pipe(
  Schema.decodeTo(Schema.NullOr(SanitizedLead), {
    decode: SchemaGetter.transform((value) => {
      const sanitizedLead: Record<string, string | Date> = {};
      for (const [key, cell] of Object.entries(value)) {
        if (cell) {
          sanitizedLead[key] = cell;
        }
      }
      return Object.values(sanitizedLead).every((cell) => cell === '') ? null : sanitizedLead;
    }),
    encode: SchemaGetter.transform((value) => value ?? {}),
  })
);

export type SanitizedRow = typeof SanitizedLead.Type;

export const joinCells = (...cells: ReadonlyArray<SanitizedRow[string] | undefined>): string | undefined =>
  cells.filter(Boolean).join(' ').trim() || undefined;

/**
 * SHA-256 of the source type and the sanitized row, with sorted columns and dates as in `raw`.
 * The same row always gets the same key, so a redrive or a resent workbook does not make a second order.
 */
export const toIdempotencyKey = (source: string, row: SanitizedRow): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        source,
        Object.entries(row)
          .map(([column, cell]) => [column, cell instanceof Date ? formatLocalIsoDate(cell) : cell])
          .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)),
      ])
    )
    .digest('hex');

export const leadFromRow = <Lead extends Schema.Top>(
  lead: Lead,
  toLead: (row: SanitizedRow) => Omit<Lead['Encoded'], 'idempotencyKey'> & { readonly extraction_source: string }
) =>
  sanitizer.pipe(
    Schema.decodeTo(lead, {
      decode: SchemaGetter.transformEffect((row, options) => {
        if (row === null) return Effect.fail(new SchemaIssue.InvalidValue({ message: 'Row is empty' }, row, options));
        const encoded = toLead(row);
        return Effect.succeed({ ...encoded, idempotencyKey: toIdempotencyKey(encoded.extraction_source, row) });
      }),
      encode: SchemaGetter.forbiddenEncoding,
    })
  );
