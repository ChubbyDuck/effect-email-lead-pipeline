import { fileSizeLogMessage, type FileSize, type RequestID } from '@leads/shared/domain/request';
import type { File } from '@leads/shared/domain/types';
import { Effect } from 'effect';

/**
 * Logs the size of a file that the handler read. The size is the length of the body that the read gave, so no AWS call
 * is added. SES bills an email by its chunks of 256 KB, and S3 bills the bytes that it keeps. The CloudWatch reader of
 * the monitor parses this line. A file without a body has no known size, so it logs nothing.
 */
export const recordFileSize = (requestID: RequestID, kind: FileSize['kind'], file: File) => {
  if (file.body === undefined) return Effect.void;
  return Effect.logInfo(fileSizeLogMessage(requestID, { kind, key: file.key, bytes: file.body.byteLength }));
};
