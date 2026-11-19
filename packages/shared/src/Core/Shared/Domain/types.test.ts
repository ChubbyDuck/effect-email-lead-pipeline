import { Buffer as NodeBuffer } from 'node:buffer';

import { Schema } from 'effect';
import { expect, test } from 'vitest';

import { LEAD_SOURCE_HEADER__BUSINESS_CLOSURE, LeadSchema_BusinessClosure } from './sources/BusinessClosure';
import { LEAD_SOURCE_HEADER__MUTATION, LeadSchema_Mutation } from './sources/Mutation';
import { LEAD_SOURCE_HEADER__NEW_ACQUISITION, LeadSchema_NewAcquisition } from './sources/NewAcquisition';
import {
  Buffer,
  EmailAttachment,
  EmailAuthentication,
  EmailSenders,
  ExcelSheet,
  File,
  Lead,
  LeadSourceTypes,
} from './types';

test('Buffer accepts a Node buffer and rejects a plain Uint8Array', () => {
  const bytes = NodeBuffer.from([1, 2, 3]);

  expect(Schema.decodeSync(Buffer)(bytes)).toEqual(bytes);
  expect(() => Schema.decodeUnknownSync(Buffer)(new Uint8Array([1, 2, 3]))).toThrow(/Expected <Declaration>/);
});

test('EmailAttachment keeps optional filename off the object when omitted', () => {
  const content = NodeBuffer.from([9]);
  const attachment = Schema.decodeSync(EmailAttachment)({ content });

  expect(attachment).toEqual({ content });
  expect('filename' in attachment).toBe(false);
});

test('EmailSenders keeps string addresses', () => {
  expect(Schema.decodeSync(EmailSenders)(['ks@example.ch'])).toEqual(['ks@example.ch']);
  expect(Schema.decodeSync(EmailSenders)([])).toEqual([]);
});

test('EmailAuthentication counts the From headers as a non-negative integer', () => {
  expect(Schema.decodeSync(EmailAuthentication)({ fromHeaders: 0, dmarc: undefined }).fromHeaders).toBe(0);
  expect(Schema.decodeSync(EmailAuthentication)({ fromHeaders: 2, dmarc: undefined }).fromHeaders).toBe(2);
});

test.each([
  { name: 'a negative', fromHeaders: -1, failure: /Expected a value greater than or equal to 0/ },
  { name: 'a non-integer', fromHeaders: 1.5, failure: /Expected an integer/ },
  { name: 'a NaN', fromHeaders: Number.NaN, failure: /Expected an integer/ },
  { name: 'an infinite', fromHeaders: Number.POSITIVE_INFINITY, failure: /Expected an integer/ },
])('EmailAuthentication refuses $name count of From headers', ({ fromHeaders, failure }) => {
  expect(() => Schema.decodeSync(EmailAuthentication)({ fromHeaders, dmarc: undefined })).toThrow(failure);
});

test('File slugifies the key basename and keeps an optional body', () => {
  const body = NodeBuffer.from([7, 8]);
  const withBody = Schema.decodeSync(File)({
    bucket: 'inbox',
    key: 'folder/My File.xlsx',
    body,
  });
  const withoutBody = Schema.decodeSync(File)({
    bucket: 'inbox',
    key: 'message.eml',
  });

  expect(withBody.body).toEqual(body);
  expect(withBody.filename).toBe('my-file');
  expect('body' in withoutBody).toBe(false);
  expect(withoutBody.filename).toBe('message');
});

test('LeadSourceTypes lists every extraction source', () => {
  expect(LeadSourceTypes).toEqual(['business_closure', 'new_acquisition', 'mutation']);
});

test('source headers come from the raw struct fields', () => {
  expect(LEAD_SOURCE_HEADER__BUSINESS_CLOSURE).toContain('Gültig ab');
  expect(LEAD_SOURCE_HEADER__NEW_ACQUISITION).toContain('MobileG');
  expect(LEAD_SOURCE_HEADER__MUTATION).toContain('Mutationsdatum');
});

test('LeadSchema_BusinessClosure formats Gültig ab dates and keeps the tagged source', () => {
  const lead = Schema.decodeSync(LeadSchema_BusinessClosure)({
    extraction_source: 'business_closure',
    idempotencyKey: 'key',
    extracted: { name: 'Acme', email: null },
    raw: { Name: 'Acme', 'Gültig ab': new Date(2024, 0, 15), 'E-Mail': 'a@b.ch' },
  });

  expect(lead.extraction_source).toBe('business_closure');
  expect(lead.extracted.email).toBe('');
  expect(lead.raw['Gültig ab']).toBe('2024-01-15');
});

test('LeadSchema_NewAcquisition and LeadSchema_Mutation decode tagged leads', () => {
  const acquisition = Schema.decodeSync(LeadSchema_NewAcquisition)({
    extraction_source: 'new_acquisition',
    idempotencyKey: 'key',
    extracted: { name: 42 },
    raw: { Name: 'Beta', MobileG: '079 000 00 00' },
  });
  const mutation = Schema.decodeSync(LeadSchema_Mutation)({
    extraction_source: 'mutation',
    idempotencyKey: 'key',
    extracted: { ownerName: 'Ada' },
    raw: { Mutationsdatum: new Date(2024, 2, 3), Zukünftiger_Betriebsname: 'Gamma' },
  });

  expect(acquisition.extracted.name).toBe('42');
  expect(mutation.raw.Mutationsdatum).toBe('2024-03-03');
  expect(Schema.decodeSync(Lead)(acquisition).extraction_source).toBe('new_acquisition');
  expect(Schema.decodeSync(Lead)(mutation).extraction_source).toBe('mutation');
});

test('ExcelSheet keeps object rows and a string header', () => {
  expect(
    Schema.decodeSync(ExcelSheet)({
      header: ['Kanton', 'Name'],
      rows: [{ Kanton: 'ZH', Name: 'Acme' }],
    })
  ).toEqual({
    header: ['Kanton', 'Name'],
    rows: [{ Kanton: 'ZH', Name: 'Acme' }],
  });
});
