/**
 * What links a message of a DLQ to the run that failed it. The requests come from the keys that the handlers write, so
 * this module reads the keys with the functions of the domain. It runs only on the server, because a hash of a key
 * needs `node:crypto`.
 */
import { originOfSource, requestIDOfEmail } from '@leads/shared/domain/keys';
import type { StageName } from '@leads/shared/domain/stages';
import { File } from '@leads/shared/domain/types';

import { type DlqEntry, type DlqMessage, leadRequestIDOf, s3KeysOf, type StoredFile } from './dlq';

/** The key as the handler reads it. S3 encodes a key in an event, with `+` for a space. */
function decodedKey(key: string): string | undefined {
  try {
    return decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    return undefined;
  }
}

/** The S3 objects of a message. An inbox message has emails, and a lead-sources message has sources. A lead has none. */
export function objectsOf(stage: StageName, { body }: DlqMessage): StoredFile[] {
  if (stage === 'leads') return [];
  return s3KeysOf(body).flatMap(({ bucket, key }) => {
    const decoded = decodedKey(key);
    return decoded === undefined ? [] : [{ bucket, key: decoded }];
  });
}

/** The requests of a message: the requests of its objects, or the request that a lead names. */
export function requestIDsOf(stage: StageName, message: DlqMessage): string[] {
  if (stage === 'leads') {
    const requestID = leadRequestIDOf(message.body);
    return requestID === undefined ? [] : [requestID];
  }
  const requestIDOf = stage === 'inbox' ? requestIDOfEmail : (file: File) => originOfSource(file).requestID;
  return [...new Set(objectsOf(stage, message).map((object) => requestIDOf(File.make(object))))];
}

const isoOfMs = (ms: string | undefined) => {
  const date = new Date(Number(ms));
  return ms === undefined || Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export function entryOf(stage: StageName, message: DlqMessage): DlqEntry {
  // SQS keeps the attributes of the source queue when it moves a message, so this is the receive of the handler.
  const receivedAt = isoOfMs(message.attributes.ApproximateFirstReceiveTimestamp ?? message.attributes.SentTimestamp);
  return {
    message,
    objects: objectsOf(stage, message),
    requestIDs: requestIDsOf(stage, message),
    ...(receivedAt !== undefined && { receivedAt }),
  };
}
