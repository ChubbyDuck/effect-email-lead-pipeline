import { randomUUID } from 'node:crypto';

import { RequestID } from '@leads/shared/domain/request';

/** A new request ID in the shape of an SES message ID, so a key that holds it is read back as the same request. */
export const newRequestID = (): RequestID => RequestID.make(randomUUID().replaceAll('-', ''));
