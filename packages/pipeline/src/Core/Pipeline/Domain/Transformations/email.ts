import { EmailAttachments, EmailAuthentication, EmailSenders } from '@leads/shared/domain/types';
import { Effect, Predicate, Schema, SchemaGetter } from 'effect';

import {
  EmailAttachments_external,
  EmailHeaderLines_external,
  EmailSenders_external,
} from '#Core/Pipeline/Domain/external';
import { toEmailAuthentication } from '#Core/Pipeline/Domain/Transformations/emailAuthentication';

export const External_EmailSenders_transformation = EmailSenders_external.pipe(
  Schema.decodeTo(EmailSenders, {
    decode: SchemaGetter.transform((from) =>
      Predicate.isNotUndefined(from) ? from.value.map((_from) => _from.address).filter(Predicate.isString) : []
    ),
    encode: SchemaGetter.forbiddenEncoding,
  }),
  Schema.withDecodingDefaultTypeKey(Effect.succeed([]))
);
export const External_EmailAttachements_transformation = EmailAttachments_external.pipe(
  Schema.decodeTo(EmailAttachments, {
    decode: SchemaGetter.transform((attachments) =>
      attachments.map((attachment) =>
        typeof attachment.filename === 'string'
          ? { filename: attachment.filename, content: attachment.content }
          : { content: attachment.content }
      )
    ),
    encode: SchemaGetter.forbiddenEncoding,
  })
);

/** An email without header lines has no From header and no DMARC result, so the guard rejects it. */
export const External_EmailAuthentication_transformation = EmailHeaderLines_external.pipe(
  Schema.decodeTo(EmailAuthentication, {
    decode: SchemaGetter.transform((headerLines) => toEmailAuthentication(headerLines.map(({ line }) => line))),
    encode: SchemaGetter.forbiddenEncoding,
  }),
  Schema.withDecodingDefaultTypeKey(Effect.succeed({ fromHeaders: 0, dmarc: undefined }))
);

export const EmailTransformation = Schema.Struct({
  attachments: External_EmailAttachements_transformation,
  senders: External_EmailSenders_transformation,
  authentication: External_EmailAuthentication_transformation,
}).pipe(Schema.encodeKeys({ senders: 'from', authentication: 'headerLines' }));
