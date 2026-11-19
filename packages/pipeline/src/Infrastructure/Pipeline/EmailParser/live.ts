import { Effect, Layer, Schema } from 'effect';
import { type ParsedMail } from 'mailparser';

import { EmailTransformation } from '#Core/Pipeline/Domain/Transformations/email';
import { readBody } from '#Core/Pipeline/Domain/Transformations/file';
import { EmailNotParsed, EmailParser } from '#Core/Pipeline/Ports/EmailParser';

const notParsed = (reason: unknown) => new EmailNotParsed({ reason });

export const makeEmailParserLive = (parseEmail: (source: Buffer) => Promise<ParsedMail>) =>
  Layer.succeed(EmailParser, {
    parse: (file) =>
      readBody(file, 'EmailParser').pipe(
        Effect.mapError(notParsed),
        Effect.andThen((buffer) => Effect.tryPromise({ try: () => parseEmail(buffer), catch: notParsed })),
        Effect.andThen((parsedEmail) =>
          Schema.decodeEffect(EmailTransformation)(parsedEmail).pipe(Effect.mapError(notParsed))
        )
      ),
  });
