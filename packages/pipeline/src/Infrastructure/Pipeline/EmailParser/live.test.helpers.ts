import { Buffer } from 'node:buffer';

import { File, type Email, type EmailAttachment } from '@leads/shared/domain/types';
import { Effect } from 'effect';
import { simpleParser, type ParsedMail } from 'mailparser';

import { EmailParser } from '#Core/Pipeline/Ports/EmailParser';

import { makeEmailParserLive } from './live';

export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export const attachmentContent = (value: string): Buffer => Buffer.from(value);

export type AttachmentInput = EmailAttachment;

const mime = (...lines: string[]) => utf8(lines.join('\r\n'));

const attachmentHeaders = (file: AttachmentInput): string[] => [
  'Content-Type: application/octet-stream',
  file.filename === undefined
    ? 'Content-Disposition: attachment'
    : `Content-Disposition: attachment; filename="${file.filename}"`,
  'Content-Transfer-Encoding: base64',
];

/** The header that SES adds above the headers of an email from example.com, folded as SES writes it. */
export const sesAuthenticationResults = (dmarc: string) =>
  [
    'Authentication-Results: amazonses.com;',
    ' spf=pass (spfCheck: domain of example.com designates 209.85.128.41 as permitted sender) client-ip=209.85.128.41;',
    ' dkim=pass header.i=@example.com;',
    ` dmarc=${dmarc} header.from=example.com;`,
  ].join('\r\n');

export const mail = (
  input: {
    /** Raw header lines above From, such as the headers that SES adds. */
    readonly headers?: readonly string[];
    readonly from?: readonly string[];
    readonly attachments?: readonly AttachmentInput[];
  } = {}
): Uint8Array => {
  const fromHeader = input.from !== undefined && input.from.length > 0 ? `From: ${input.from.join(', ')}` : undefined;
  const headers = [...(input.headers ?? []), ...(fromHeader === undefined ? [] : [fromHeader])];
  const attachments = input.attachments ?? [];

  if (attachments.length === 0) {
    return mime(...headers, 'To: inbox@example.com', '', 'body');
  }

  const parts = ['--x', 'Content-Type: text/plain', '', 'hi'];
  for (const file of attachments) {
    parts.push('--x', ...attachmentHeaders(file), '', Buffer.from(file.content).toString('base64'));
  }
  parts.push('--x--', '');

  return mime(...headers, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="x"', '', ...parts);
};

const emailFile = (body: Uint8Array | undefined): File =>
  File.make(
    body === undefined
      ? { bucket: 'inbox', key: 'message.eml' }
      : { bucket: 'inbox', key: 'message.eml', body: Buffer.from(body) }
  );

const EmailParserLive = makeEmailParserLive(simpleParser);

const provide = (layer: typeof EmailParserLive) => (body: Uint8Array | undefined) =>
  Effect.gen(function* () {
    const parser = yield* EmailParser;
    return yield* parser.parse(emailFile(body));
  }).pipe(Effect.provide(layer));

export const parseEmail = (buffer: Uint8Array): Promise<Email> => Effect.runPromise(provide(EmailParserLive)(buffer));

export const parseError = (buffer: Uint8Array | undefined, parseEmailFn?: (source: Buffer) => Promise<ParsedMail>) =>
  Effect.runPromise(
    provide(parseEmailFn === undefined ? EmailParserLive : makeEmailParserLive(parseEmailFn))(buffer).pipe(Effect.flip)
  );

export const parseParsedMail = (input: {
  readonly senders?: ReadonlyArray<{ readonly name: string; readonly address?: string }>;
  readonly attachments?: readonly AttachmentInput[];
}): Promise<Email> =>
  Effect.runPromise(
    provide(
      makeEmailParserLive(
        async () =>
          ({
            attachments: (input.attachments ?? []).map((file) => ({
              filename: file.filename,
              content: Buffer.from(file.content),
            })),
            from:
              input.senders === undefined
                ? undefined
                : {
                    value: input.senders.map((sender) => ({ name: sender.name, address: sender.address })),
                    html: '',
                    text: '',
                  },
          }) as ParsedMail
      )
    )(utf8('not empty'))
  );

export const trackingParser = () => {
  let called = false;
  return {
    wasCalled: () => called,
    parseEmail: async (): Promise<ParsedMail> => {
      called = true;
      throw new Error('should not parse');
    },
  };
};

export const parserFailure = new Error('boom');

export const rejectingParser = () => Promise.reject(parserFailure);

export const throwingParser = (): Promise<ParsedMail> => {
  throw parserFailure;
};
