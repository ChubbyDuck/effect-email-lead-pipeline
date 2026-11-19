import { Schema } from 'effect';

import { ExcelCell, joinCells, leadFromRow, optionalCoercedString } from '../schemas';

export const LeadSourceTypeSchema_NewAcquisition = Schema.Literal('new_acquisition');

export type LeadSourceType_NewAcquisition = typeof LeadSourceTypeSchema_NewAcquisition.Type;

export const LeadDataSchema_NewAcquisition = Schema.Struct({
  UIDNr: ExcelCell,
  SubNr: ExcelCell,
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
  MobileG: ExcelCell,
  Bemerkung: ExcelCell,
});

export type LeadData_NewAcquisition = typeof LeadDataSchema_NewAcquisition.Type;

export const LEAD_SOURCE_HEADER__NEW_ACQUISITION = Object.keys(LeadDataSchema_NewAcquisition.fields) as Array<
  keyof LeadData_NewAcquisition
>;

export type LeadSourceHeader_NewAcquisition = keyof LeadData_NewAcquisition;

export const LeadExtractedDataSchema_NewAcquisition = Schema.Struct({
  name: optionalCoercedString,
  companyAdditional: optionalCoercedString,
  street: optionalCoercedString,
  zip: optionalCoercedString,
  city: optionalCoercedString,
  phone: optionalCoercedString,
  mobile: optionalCoercedString,
  uid: optionalCoercedString,
  subjectNumber: optionalCoercedString,
});

export type LeadExtractedData_NewAcquisition = typeof LeadExtractedDataSchema_NewAcquisition.Type;

export const LeadSchema_NewAcquisition = Schema.Struct({
  extraction_source: LeadSourceTypeSchema_NewAcquisition,
  /** Stable key of this lead for the order API. See `toIdempotencyKey`. */
  idempotencyKey: Schema.String,
  extracted: LeadExtractedDataSchema_NewAcquisition,
  raw: LeadDataSchema_NewAcquisition,
});

export const LeadFromRow_NewAcquisition = leadFromRow(LeadSchema_NewAcquisition, (row) => ({
  extraction_source: LeadSourceTypeSchema_NewAcquisition.literal,
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
  },
}));
