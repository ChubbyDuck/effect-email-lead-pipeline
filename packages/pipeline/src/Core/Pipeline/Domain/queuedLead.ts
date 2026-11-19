import { RequestID } from '@leads/shared/domain/request';
import { Lead } from '@leads/shared/domain/types';
import { Schema } from 'effect';

/**
 * The body of a message on the leads queue: the lead, and the request that it comes from. The queue is the only link
 * between the lead-sources handler and the lead handler, so this codec writes each body and reads it back, and the two
 * sides cannot drift apart.
 */
export const QueuedLead = Schema.Struct({ lead: Lead, requestID: RequestID });
export type QueuedLead = typeof QueuedLead.Type;

const QueuedLeadBody = Schema.fromJsonString(QueuedLead);

/** The body of the message that carries the lead. */
export const encodeQueuedLead = Schema.encodeSync(QueuedLeadBody);
/** Reads back a body that `encodeQueuedLead` wrote. */
export const decodeQueuedLead = Schema.decodeUnknownEffect(QueuedLeadBody);
