import { Schema } from 'effect';
import type { ParsedMail } from 'mailparser';
import { expect, test } from 'vitest';

import { FileIsEmpty } from '#Core/Pipeline/Domain/Exceptions/FileIsEmpty';
import { EmailNotParsed } from '#Core/Pipeline/Ports/EmailParser';

import {
  attachmentContent,
  mail,
  parseEmail,
  parseError,
  parseParsedMail,
  parserFailure,
  rejectingParser,
  sesAuthenticationResults,
  throwingParser,
  trackingParser,
  utf8,
} from './live.test.helpers';

test('parses a single sender address from a MIME email', async () => {
  const senders = ['ks@example.ch'];
  const email = await parseEmail(mail({ from: senders }));

  expect(email.senders).toEqual(senders);
});

test('parses multiple sender addresses', async () => {
  const senders = ['ada@example.ch', 'ks@example.ch'];
  const email = await parseEmail(mail({ from: senders }));

  expect(email.senders).toEqual(senders);
});

test('returns no senders when From is missing', async () => {
  const email = await parseEmail(mail());

  expect(email.senders).toEqual([]);
});

test('keeps only sender addresses that are strings', async () => {
  const email = await parseParsedMail({
    senders: [{ name: 'Ada' }, { name: 'KS', address: 'ks@example.ch' }],
  });

  expect(email.senders).toEqual(['ks@example.ch']);
});

test('maps attachment filename and content', async () => {
  const leads = { filename: 'leads.xlsx', content: attachmentContent('hello') };
  const email = await parseEmail(mail({ from: ['ks@example.ch'], attachments: [leads] }));

  expect(email.attachments).toEqual([leads]);
});

test('omits filename when the attachment has none, and maps every attachment', async () => {
  const unnamed = { content: attachmentContent('a') };
  const named = { filename: 'leads.xlsx', content: attachmentContent('b') };
  const email = await parseParsedMail({ attachments: [unnamed, named] });

  expect(email.attachments).toEqual([unnamed, named]);
});

test('returns empty senders and attachments for non-email files', async () => {
  const email = await parseEmail(utf8('Lorem ipsum dolor sit amet.'));

  expect(email).toEqual({ senders: [], attachments: [], authentication: { fromHeaders: 0, dmarc: undefined } });
});

const owner = 'owner@example.com';

test('reads the DMARC result that SES added above the headers of the sender', async () => {
  const email = await parseEmail(mail({ headers: [sesAuthenticationResults('pass')], from: [owner] }));

  expect(email.authentication).toEqual({ fromHeaders: 1, dmarc: { verdict: 'pass', domain: 'example.com' } });
});

test('reads the same authentication from an email with attachments', async () => {
  const email = await parseEmail(
    mail({
      headers: [sesAuthenticationResults('pass')],
      from: [owner],
      attachments: [{ filename: 'leads.xlsx', content: attachmentContent('a') }],
    })
  );

  expect(email.authentication).toEqual({ fromHeaders: 1, dmarc: { verdict: 'pass', domain: 'example.com' } });
});

test('has no DMARC result when SES added no Authentication-Results header', async () => {
  const email = await parseEmail(mail({ from: [owner] }));

  expect(email.authentication).toEqual({ fromHeaders: 1, dmarc: undefined });
});

// The MIME parser keeps only one of the two From headers: the last one up to mailparser 3.9, the first one after it. The
// guard rejects an email with more than one From header, so the count matters, not the sender that the parser keeps.
test('counts both From headers, while the MIME parser keeps only one', async () => {
  const email = await parseEmail(
    mail({ headers: [sesAuthenticationResults('pass'), 'From: outside@example.org'], from: [owner] })
  );

  expect(email.senders).toHaveLength(1);
  expect(email.authentication.fromHeaders).toBe(2);
});

test('trusts only the topmost Authentication-Results header, not a forged one from the sender below it', async () => {
  const forged = 'Authentication-Results: amazonses.com; dmarc=pass header.from=example.com;';
  const email = await parseEmail(mail({ headers: [sesAuthenticationResults('fail'), forged], from: [owner] }));

  expect(email.authentication.dmarc).toEqual({ verdict: 'fail', domain: 'example.com' });
});

test('has no DMARC result when the topmost Authentication-Results header is not from SES', async () => {
  const foreign = 'Authentication-Results: mx.example.org; dmarc=pass header.from=example.com;';
  const email = await parseEmail(mail({ headers: [foreign, sesAuthenticationResults('pass')], from: [owner] }));

  expect(email.authentication.dmarc).toBeUndefined();
});

test('has no authentication when the MIME parser gives no header lines', async () => {
  const email = await parseParsedMail({ senders: [{ name: 'KS', address: owner }] });

  expect(email.authentication).toEqual({ fromHeaders: 0, dmarc: undefined });
});

test.each([
  { name: 'undefined', buffer: undefined },
  { name: 'zero-length', buffer: new Uint8Array() },
])('fails with EmailNotParsed due to FileIsEmpty when the buffer is $name', async ({ buffer }) => {
  const parser = trackingParser();
  const error = await parseError(buffer, parser.parseEmail);

  expect(parser.wasCalled()).toBe(false);
  expect(error).toBeInstanceOf(EmailNotParsed);
  expect(error.reason).toBeInstanceOf(FileIsEmpty);
  expect(error.reason).toMatchObject({ service: 'EmailParser', reason: 'message.eml' });
  expect(error.message).toBe('Email cannot be parsed due to: File is empty in EmailParser');
});

test('fails with EmailNotParsed that keeps the rejection unchanged as its reason', async () => {
  const error = await parseError(utf8('not empty'), rejectingParser);

  expect(error).toBeInstanceOf(EmailNotParsed);
  expect(error.reason).toBe(parserFailure);
  expect(error.message).toBe('Email cannot be parsed due to: boom');
});

test('fails with EmailNotParsed that keeps the thrown error unchanged as its reason', async () => {
  const error = await parseError(utf8('not empty'), throwingParser);

  expect(error).toBeInstanceOf(EmailNotParsed);
  expect(error.reason).toBe(parserFailure);
  expect(error.message).toBe('Email cannot be parsed due to: boom');
});

test('fails with EmailNotParsed that keeps the decode failure unchanged as its reason', async () => {
  const error = await parseError(
    utf8('not empty'),
    async () => ({ attachments: 'not a list' }) as unknown as ParsedMail
  );

  expect(error).toBeInstanceOf(EmailNotParsed);
  expect(error.reason).toBeInstanceOf(Schema.SchemaError);
});
