import { gigabytesOf } from '@leads/shared/domain/billing';
import { prices } from '@leads/shared/domain/prices';

import { leadLedgerWrites, type LeadInputs } from './leads';
import { sourceLedgerWrites, type SliceInputs } from './sources';

/**
 * Bytes of the lines that one handler writes to its log group. Measured on the runs of request
 * `ntls5k1165jcg1a8otpg8kcqrsva6q18lk7ond81` on 16 October 2026. An SES request ID has 40 characters.
 */
export const logLineBytes = {
  /** `START` (71), `END` (52), and a `REPORT` line without an init time (146). Lambda writes them for every run. */
  platform: 71 + 52 + 146,
  /** `INIT_START` (172), and the init time on the `REPORT` line (25). Only a new environment writes them. */
  coldStart: 172 + 25,
  /** One `Progress of request <id>: {json}` line. Measured 173 to 198 bytes. */
  progress: 185,
  /** The `File size of request <id>: {json}` line of the email. */
  emailSize: 236,
  /** The size line of a source. Its key also holds the folder and the file name. Measured 266 to 274 bytes. */
  sourceSize: 270,
};

/**
 * Progress lines of one inbox handler: the attachment count and the end. The acknowledgement puts the entry without a
 * progress line.
 */
export const inboxProgressLines = 2;

/** The price of `bytes` that a log group takes in. */
export const logIngestCost = (bytes: number) => gigabytesOf(bytes) * prices.logIngestGb;

/**
 * The price of `bytes` that a log group keeps for one month. The log groups keep their lines with no end, so each later
 * month costs the same again. The bill counts the first month, as the lab counts one month of what the groups keep.
 */
export const logStorageCost = (bytes: number) => gigabytesOf(bytes) * prices.logStorageGbMonth;

/** The price of `bytes` of log lines: taken in, and kept for one month. */
export const logCost = (bytes: number) => logIngestCost(bytes) + logStorageCost(bytes);

/** Log bytes of one inbox handler: the platform lines, the size of the email, and its progress lines. */
export const inboxLogBytes = () =>
  logLineBytes.platform + logLineBytes.emailSize + inboxProgressLines * logLineBytes.progress;

/** Log bytes of one source handler: the platform lines, the size of the source, and one progress line for each ledger write. */
export const sourceLogBytes = (input: Pick<SliceInputs, 'L'>) =>
  logLineBytes.platform + logLineBytes.sourceSize + sourceLedgerWrites(input) * logLineBytes.progress;

/** Log bytes of one lead handler of `leads` leads: the platform lines, and one progress line for each ledger write. */
export const leadLogBytes = (input: LeadInputs, leads: number) =>
  logLineBytes.platform + leadLedgerWrites(input, leads) * logLineBytes.progress;
