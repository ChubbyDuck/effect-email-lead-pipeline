import { type Dmarc, DmarcVerdict, type EmailAuthentication } from '@leads/shared/domain/types';
import { Schema } from 'effect';

/**
 * The authserv-id that SES writes into its `Authentication-Results` header (RFC 8601).
 * The SES receiving docs show the header only with the placeholder `example.com`. Check this value against the
 * header of a real email that SES stores in the inbox bucket. A wrong value rejects and deletes every email.
 */
export const SES_AUTHSERV_ID = 'amazonses.com';

const isDmarcVerdict = Schema.is(DmarcVerdict);

/** The field name before the first colon, in lowercase. A line without a colon has no name. */
const nameOf = (field: string): string => {
  const colon = field.indexOf(':');
  return colon === -1 ? '' : field.slice(0, colon).trim().toLowerCase();
};

/** The value after the first colon, unfolded to one line. */
const valueOf = (field: string): string => field.slice(field.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ');

/** Drops RFC 5322 comments, which can nest, such as `(spfCheck: 10.0.0.1 is permitted (relay))`. Quoted text stays. */
const withoutComments = (value: string): string => {
  let result = '';
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === '\\') {
      if (depth === 0) result += value.slice(index, index + 2);
      index++;
    } else if (depth === 0 && char === '"') {
      quoted = !quoted;
      result += char;
    } else if (!quoted && char === '(') {
      depth++;
    } else if (!quoted && depth > 0 && char === ')') {
      depth--;
    } else if (depth === 0) {
      result += char;
    }
  }
  return result;
};

/** The domain of `header.from`. SES docs show an address there, such as `example@example.com`, so both forms count. */
const toDomain = (value: string): string | undefined => {
  const domain = value.replace(/^"|"$/g, '').split('@').pop()!.trim().toLowerCase();
  return domain === '' ? undefined : domain;
};

/**
 * Reads the DMARC result from the value of one `Authentication-Results` header.
 * Only a header with the SES authserv-id counts. A header without a readable `dmarc` result gives `undefined`.
 */
export const toDmarc = (value: string): Dmarc | undefined => {
  const [authservID = '', ...results] = withoutComments(value).split(';');
  if (authservID.trim().split(/\s+/)[0]?.toLowerCase() !== SES_AUTHSERV_ID) return undefined;

  for (const result of results) {
    const verdict = /^\s*dmarc\s*=\s*([a-z]+)/i.exec(result)?.[1]?.toLowerCase();
    if (verdict === undefined) continue;
    const headerFrom = /(?:^|\s)header\.from\s*=\s*("[^"]*"|[^\s;]+)/i.exec(result)?.[1];
    const domain = headerFrom === undefined ? undefined : toDomain(headerFrom);
    return isDmarcVerdict(verdict) && domain !== undefined ? { verdict, domain } : undefined;
  }
  return undefined;
};

/**
 * Reads the authentication of an email from its raw header fields, in the order of the email.
 * SES adds its `Authentication-Results` header above the headers of the sender, and a sender can add its own
 * below. So only the topmost one counts, and a foreign or unreadable topmost header means no DMARC result.
 */
export const toEmailAuthentication = (fields: readonly string[]): EmailAuthentication => {
  const topmost = fields.find((field) => nameOf(field) === 'authentication-results');
  return {
    fromHeaders: fields.filter((field) => nameOf(field) === 'from').length,
    dmarc: topmost === undefined ? undefined : toDmarc(valueOf(topmost)),
  };
};
