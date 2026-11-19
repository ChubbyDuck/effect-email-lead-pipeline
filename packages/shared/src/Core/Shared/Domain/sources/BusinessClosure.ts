import { Schema } from 'effect';

import { ExcelCell, ExcelDateCell, joinCells, leadFromRow, optionalCoercedString } from '../schemas';

export const LeadSourceTypeSchema_BusinessClosure = Schema.Literal('business_closure');

export type LeadSourceType_BusinessClosure = typeof LeadSourceTypeSchema_BusinessClosure.Type;

export const LeadDataSchema_BusinessClosure = Schema.Struct({
  UIDNr: ExcelCell,
  SubNr: ExcelCell,
  AbrNr: ExcelCell,
  Name: ExcelCell,
  Zusatzname: ExcelCell,
  AdrZusatz: ExcelCell,
  Strasse: ExcelCell,
  Plz: ExcelCell,
  Ort: ExcelCell,
  Kt: ExcelCell,
  PrimTel: ExcelCell,
  KontTel: ExcelCell,
  TelP: ExcelCell,
  TelG: ExcelCell,
  MobileP: ExcelCell,
  'E-Mail': ExcelCell,
  Pakete: ExcelCell,
  'Gültig ab': ExcelDateCell,
  Bemerkung: ExcelCell,
});

export type LeadData_BusinessClosure = typeof LeadDataSchema_BusinessClosure.Type;

export type LeadSourceHeader_BusinessClosure = keyof LeadData_BusinessClosure;

export const LEAD_SOURCE_HEADER__BUSINESS_CLOSURE = Object.keys(
  LeadDataSchema_BusinessClosure.fields
) as Array<LeadSourceHeader_BusinessClosure>;

export const LeadExtractedDataSchema_BusinessClosure = Schema.Struct({
  name: optionalCoercedString,
  companyAdditional: optionalCoercedString,
  street: optionalCoercedString,
  zip: optionalCoercedString,
  city: optionalCoercedString,
  phone: optionalCoercedString,
  mobile: optionalCoercedString,
  uid: optionalCoercedString,
  subjectNumber: optionalCoercedString,
  email: optionalCoercedString,
});

export type LeadExtractedData_BusinessClosure = typeof LeadExtractedDataSchema_BusinessClosure.Type;

export const LeadSchema_BusinessClosure = Schema.Struct({
  extraction_source: LeadSourceTypeSchema_BusinessClosure,
  /** Stable key of this lead for the order API. See `toIdempotencyKey`. */
  idempotencyKey: Schema.String,
  extracted: LeadExtractedDataSchema_BusinessClosure,
  raw: LeadDataSchema_BusinessClosure,
});

export const LeadFromRow_BusinessClosure = leadFromRow(LeadSchema_BusinessClosure, (row) => ({
  extraction_source: LeadSourceTypeSchema_BusinessClosure.literal,
  raw: row,
  extracted: {
    name: row['Name'],
    companyAdditional: joinCells(row['Zusatzname'], row['AdrZusatz']),
    street: row['Strasse'],
    zip: row['Plz'],
    city: row['Ort'],
    phone: row['PrimTel'],
    mobile: row['KontTel'],
    uid: row['UIDNr'],
    subjectNumber: row['SubNr'],
    email: row['E-Mail'],
  },
}));
