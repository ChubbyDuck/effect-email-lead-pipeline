import { type RequestFolder, sourceKey } from '@leads/shared/domain/keys';
import { type Buffer, type EmailAttachment, File } from '@leads/shared/domain/types';
import { Effect } from 'effect';

import { FileIsEmpty } from '#Core/Pipeline/Domain/Exceptions/FileIsEmpty';

export const readBody = (file: File, service: string): Effect.Effect<Buffer, FileIsEmpty> =>
  file.body === undefined || file.body.byteLength === 0
    ? Effect.fail(new FileIsEmpty({ service, reason: file.key }))
    : Effect.succeed(file.body);

/** The source file of one attachment, in the folder of its request. `index` is the 0-based index in the email. */
export const toSourceFile = (bucket: string, at: RequestFolder, index: number, attachment: EmailAttachment): File =>
  File.make({
    bucket,
    body: attachment.content,
    key: sourceKey({ ...at, index, filename: attachment.filename }),
  });
