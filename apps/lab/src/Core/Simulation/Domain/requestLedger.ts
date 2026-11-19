import { dynamoWriteUnitBytes } from '@leads/shared/domain/billing';
import { prices } from '@leads/shared/domain/prices';

/**
 * Bytes of one request entry: the request ID, two ISO dates, the inbox status, the attachment count, and nine counters.
 * An estimate. DynamoDB bills an update by the larger of the item before and after it, so no write of the entry is
 * larger than this.
 */
export const requestEntryBytes = 400;

/** Write request units of one write of a request entry. */
export const requestEntryWriteUnits = Math.max(1, Math.ceil(requestEntryBytes / dynamoWriteUnitBytes));

/** The price of `writes` writes of a request entry. */
export const ledgerWriteCost = (writes: number) => writes * requestEntryWriteUnits * prices.dynamoWriteUnit;
