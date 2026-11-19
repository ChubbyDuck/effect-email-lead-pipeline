import { Buffer as NodeBuffer } from 'node:buffer';

import { Schema } from 'effect';

export const Buffer = Schema.declare((input: unknown): input is Buffer => input instanceof NodeBuffer);
export const EmailAttachments_external = Schema.Array(
  Schema.Struct({
    filename: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    content: Buffer,
  })
);
export const EmailSenders_external = Schema.optionalKey(
  Schema.UndefinedOr(
    Schema.Struct({
      value: Schema.Array(Schema.Struct({ address: Schema.optionalKey(Schema.UndefinedOr(Schema.String)) })),
    })
  )
);
/** The raw header fields of the top-level header section, in the order of the email. Folded lines stay folded. */
export const EmailHeaderLines_external = Schema.Array(Schema.Struct({ line: Schema.String }));

export const Email_external = Schema.Struct({
  attachments: EmailAttachments_external,
  from: EmailSenders_external,
  headerLines: Schema.optionalKey(EmailHeaderLines_external),
});
