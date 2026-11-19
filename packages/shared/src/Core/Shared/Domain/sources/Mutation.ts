import { Schema } from 'effect';

import { ExcelCell, ExcelDateCell, leadFromRow, optionalCoercedString } from '../schemas';

export const LeadSourceTypeSchema_Mutation = Schema.Literal('mutation');

export type LeadSourceType_Mutation = typeof LeadSourceTypeSchema_Mutation.Type;

export const LeadDataSchema_Mutation = Schema.Struct({
  Kanton: ExcelCell,
  Gegenwärtiger_Betriebsname: ExcelCell,
  Gegenwärtiger_Wirtename: ExcelCell,
  Strasse_Nr: ExcelCell,
  Postfach: ExcelCell,
  PLZ: ExcelCell,
  Ort: ExcelCell,
  Telefon: ExcelCell,
  www: ExcelCell,
  'E-Mail': ExcelCell,
  Mutationsgrund: ExcelCell,
  Mutationsdatum: ExcelDateCell,
  Zukünftiger_Betriebsname: ExcelCell,
  Rechtsform: ExcelCell,
  Zukünftiger_Wirtename: ExcelCell,
  Anzahl_Gästezimmer: ExcelCell,
  Sitzplätze_Innen: ExcelCell,
  Sitzplätze_Aussen: ExcelCell,
  Erreichbarkeit_Name: ExcelCell,
  Erreichbarkeit_Strasse: ExcelCell,
  Erreichbarkeit_PLZ_Ort: ExcelCell,
  Erreichbarkeit_Tel: ExcelCell,
});

export type LeadData_Mutation = typeof LeadDataSchema_Mutation.Type;

export type LeadSourceHeader_Mutation = keyof LeadData_Mutation;

export const LEAD_SOURCE_HEADER__MUTATION = Object.keys(
  LeadDataSchema_Mutation.fields
) as Array<LeadSourceHeader_Mutation>;

export const LeadExtractedDataSchema_Mutation = Schema.Struct({
  name: optionalCoercedString,
  ownerName: optionalCoercedString,
  street: optionalCoercedString,
  zip: optionalCoercedString,
  city: optionalCoercedString,
  phone: optionalCoercedString,
  email: optionalCoercedString,
  mobile: optionalCoercedString,
});

export type LeadExtractedData_Mutation = typeof LeadExtractedDataSchema_Mutation.Type;

export const LeadSchema_Mutation = Schema.Struct({
  extraction_source: LeadSourceTypeSchema_Mutation,
  /** Stable key of this lead for the order API. See `toIdempotencyKey`. */
  idempotencyKey: Schema.String,
  extracted: LeadExtractedDataSchema_Mutation,
  raw: LeadDataSchema_Mutation,
});

export const LeadFromRow_Mutation = leadFromRow(LeadSchema_Mutation, (row) => ({
  extraction_source: LeadSourceTypeSchema_Mutation.literal,
  raw: row,
  extracted: {
    name: row['Zukünftiger_Betriebsname'],
    ownerName: row['Zukünftiger_Wirtename'],
    street: row['Strasse_Nr'],
    zip: row['PLZ'],
    city: row['Ort'],
    phone: row['Telefon'],
    email: row['E-Mail'],
    mobile: row['Erreichbarkeit_Tel'],
  },
}));
