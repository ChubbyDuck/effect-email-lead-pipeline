import { Buffer as NodeBuffer } from 'node:buffer';

import { Schema } from 'effect';
import v from 'voca';

import type { LeadSourceHeader_BusinessClosure } from './sources/BusinessClosure';
import {
  LeadDataSchema_BusinessClosure,
  LeadExtractedDataSchema_BusinessClosure,
  LeadSchema_BusinessClosure,
  LeadSourceTypeSchema_BusinessClosure,
} from './sources/BusinessClosure';
import type { LeadSourceHeader_Mutation } from './sources/Mutation';
import {
  LeadDataSchema_Mutation,
  LeadExtractedDataSchema_Mutation,
  LeadSchema_Mutation,
  LeadSourceTypeSchema_Mutation,
} from './sources/Mutation';
import type { LeadSourceHeader_NewAcquisition } from './sources/NewAcquisition';
import {
  LeadDataSchema_NewAcquisition,
  LeadExtractedDataSchema_NewAcquisition,
  LeadSchema_NewAcquisition,
  LeadSourceTypeSchema_NewAcquisition,
} from './sources/NewAcquisition';

export const Buffer = Schema.declare((input: unknown): input is NodeBuffer => input instanceof NodeBuffer);
export type Buffer = typeof Buffer.Type;

export const EmailAttachment = Schema.Struct({
  filename: Schema.optionalKey(Schema.String),
  content: Buffer,
});
export type EmailAttachment = typeof EmailAttachment.Type;
export const EmailAttachments = Schema.Array(EmailAttachment);

export const EmailSenders = Schema.Array(Schema.String);

/** The DMARC results of RFC 8601. */
export const DmarcVerdict = Schema.Literals(['pass', 'fail', 'none', 'temperror', 'permerror']);
export type DmarcVerdict = typeof DmarcVerdict.Type;

/** The DMARC check that SES ran on the received email: its verdict and the lowercase From domain it checked. */
export const Dmarc = Schema.Struct({
  verdict: DmarcVerdict,
  domain: Schema.String,
});
export type Dmarc = typeof Dmarc.Type;

/**
 * What proves that the From header is real: the number of From headers in the email,
 * and the DMARC check of SES, or `undefined` when SES did not report one that can be trusted.
 */
export const EmailAuthentication = Schema.Struct({
  fromHeaders: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  dmarc: Schema.UndefinedOr(Dmarc),
});
export type EmailAuthentication = typeof EmailAuthentication.Type;

export const Email = Schema.Struct({
  attachments: EmailAttachments,
  senders: EmailSenders,
  authentication: EmailAuthentication,
});
export type Email = typeof Email.Type;

export class File extends Schema.Class<File>('File')({
  bucket: Schema.String,
  key: Schema.String,
  body: Schema.optionalKey(Schema.UndefinedOr(Buffer)),
}) {
  get filename() {
    return v.slugify((this.key.split('/').pop() ?? '').split('.').shift());
  }
}

export type LeadHeader = LeadSourceHeader_BusinessClosure | LeadSourceHeader_NewAcquisition | LeadSourceHeader_Mutation;

export const LeadData = Schema.Union([
  LeadDataSchema_BusinessClosure,
  LeadDataSchema_NewAcquisition,
  LeadDataSchema_Mutation,
]);

export type LeadData = typeof LeadData.Type;

export const LeadSourceType = Schema.Literals([
  LeadSourceTypeSchema_BusinessClosure.literal,
  LeadSourceTypeSchema_NewAcquisition.literal,
  LeadSourceTypeSchema_Mutation.literal,
]);

export type LeadSourceType = typeof LeadSourceType.Type;

export const LeadSourceTypes = LeadSourceType.literals;

export const LeadExtractedData = Schema.Union([
  LeadExtractedDataSchema_BusinessClosure,
  LeadExtractedDataSchema_NewAcquisition,
  LeadExtractedDataSchema_Mutation,
]);

export type LeadExtractedData = typeof LeadExtractedData.Type;

export const Lead = Schema.Union([LeadSchema_BusinessClosure, LeadSchema_NewAcquisition, LeadSchema_Mutation]);

export type Lead = typeof Lead.Type;
export const Leads = Schema.Array(Lead);
export type Leads = typeof Leads.Type;

export const ExcelSheet = Schema.Struct({
  header: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.ObjectKeyword),
});

export type ExcelSheet = typeof ExcelSheet.Type;

const LeadSchemaFromObject = Schema.ObjectKeyword.pipe(Schema.decodeTo(Lead));
export const LeadSchemaFromJSON = Schema.Json.pipe(Schema.decodeTo(LeadSchemaFromObject));
