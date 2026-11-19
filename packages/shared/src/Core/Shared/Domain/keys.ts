import { createHash } from 'node:crypto';

import { format, getMinutes, setMinutes } from 'date-fns';
import v from 'voca';

import { RequestID } from '#Core/Shared/Domain/request';
import type { File } from '#Core/Shared/Domain/types';

/**
 * The layout of every key that carries a request ID. S3 and its notifications are the only link between the stages,
 * so the key is how a stage hands the request ID to the next one. This module writes each key and reads it back, so
 * the two sides cannot drift apart.
 */

/** An SES message ID, which SES uses as the name of the email object. A hash of a location has the same shape. */
const REQUEST_ID = /^[a-z0-9]{32,64}$/;

/** The folder of one request: the time folders, then the request ID. Every stage keeps the files of a request in it. */
export type RequestFolder = {
  /** The day folder, such as `15-01-2024`. */
  readonly folder: string;
  /** The time folder, such as `14-30`. */
  readonly subFolder: string;
  readonly requestID: RequestID;
};

/** The folder of a request that arrived at `receivedAt`. The time folder rounds the minutes down to 10. */
export const requestFolderOf = (receivedAt: Date, requestID: RequestID): RequestFolder => ({
  folder: format(receivedAt, 'dd-MM-yyyy'),
  subFolder: format(setMinutes(receivedAt, Math.floor(getMinutes(receivedAt) / 10) * 10), 'HH-mm'),
  requestID,
});

const requestFolderKey = ({ folder, subFolder, requestID }: RequestFolder): string =>
  `${folder}/${subFolder}/${requestID}`;

const lastSegment = (key: string): string => key.split('/').at(-1) ?? '';

/** A hash of the location of the file in the shape of an SES message ID, so the same file gets the same ID every time. */
const requestIDOfLocation = (file: File): RequestID =>
  RequestID.make(createHash('sha256').update(`${file.bucket}/${file.key}`).digest('hex').slice(0, 40));

/**
 * The request of an email: the SES message ID from the name of the email object. An email that SES did not write,
 * such as a manual upload, gets a hash of its location. Both are deterministic, so a second delivery of the same email
 * gets the same request.
 */
export const requestIDOfEmail = (file: File): RequestID => {
  const name = lastSegment(file.key);
  return REQUEST_ID.test(name) ? RequestID.make(name) : requestIDOfLocation(file);
};

/** The 1-based position of the attachment in the email, so attachments with the same name get different keys. */
const positionOf = (index: number): string => String(index + 1).padStart(2, '0');

/** The slug of the file name without its extension. `slugify` gives `''`, not `undefined`, for a name it cannot use. */
const nameOf = (filename: string | undefined): string => v.slugify(filename?.split('.').shift()) || 'attachment';

/** The key of one source of an email. The position keeps attachments with the same name apart. */
export const sourceKey = (
  at: RequestFolder & {
    /** The 0-based index of the attachment in the email. */
    readonly index: number;
    readonly filename: string | undefined;
  }
): string => `${requestFolderKey(at)}/${positionOf(at.index)}-${nameOf(at.filename)}`;

/** Where a source gets its request from. */
export type SourceOrigin =
  /** The inbox handler wrote the source into the folder of its email, so the source belongs to the request of the email. */
  | { readonly _tag: 'FromEmail'; readonly requestID: RequestID }
  /**
   * The key is not in the folder of an email, such as a manual upload. The source is a request of its own, with a hash
   * of its location as the ID, so a second delivery of the same source gets the same request.
   */
  | { readonly _tag: 'Standalone'; readonly requestID: RequestID };

/** Reads the request of a source back from the key that `sourceKey` wrote. */
export const originOfSource = (file: File): SourceOrigin => {
  const parent = file.key.split('/').at(-2);
  return parent !== undefined && REQUEST_ID.test(parent)
    ? { _tag: 'FromEmail', requestID: RequestID.make(parent) }
    : { _tag: 'Standalone', requestID: requestIDOfLocation(file) };
};
