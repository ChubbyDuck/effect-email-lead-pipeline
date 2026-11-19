import { Buffer } from 'node:buffer';

import type { EmailAuthentication } from '@leads/shared/domain/types';
import { definePortMock } from '@leads/shared/testing/variants';
import { Effect } from 'effect';

import { EmailNotParsed, EmailParser } from '#Core/Pipeline/Ports/EmailParser';

/** Every parsed email has one From header and a passing DMARC check, so only the Guard variant decides. */
export const authentication: EmailAuthentication = {
  fromHeaders: 1,
  dmarc: { verdict: 'pass', domain: 'example.com' },
};

const emailParserMock = definePortMock(EmailParser, ({ method, record, observation }) => {
  const parse = record('parse');

  return {
    variants: {
      parse: method('parse', {
        failsWithEmailNotParsed: (file) =>
          parse(file).pipe(Effect.andThen(Effect.fail(new EmailNotParsed({ reason: 'cannot parse' })))),
        succeedsWithoutAttachments: (file) =>
          parse(file).pipe(
            Effect.andThen(Effect.succeed({ senders: ['sender@example.com'], attachments: [], authentication }))
          ),
        succeedsWithTwoAttachments: (file) =>
          parse(file).pipe(
            Effect.andThen(
              Effect.succeed({
                senders: ['sender@example.com'],
                attachments: [
                  { filename: 'lead.xlsx', content: Buffer.from('attachment') },
                  { filename: 'broken.xlsx', content: Buffer.from('attachment') },
                ],
                authentication,
              })
            )
          ),
        succeeds: (file) =>
          parse(file).pipe(
            Effect.andThen(
              Effect.succeed({
                senders: ['sender@example.com'],
                attachments: [{ filename: 'lead.xlsx', content: Buffer.from('attachment') }],
                authentication,
              })
            )
          ),
      }),
    },
    observation,
  };
});

export const emailParserBuilder = emailParserMock.builder;
export const makeEmailParser = emailParserMock.make;
