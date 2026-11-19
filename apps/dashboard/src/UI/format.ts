import type { LeadSourceType } from '@leads/shared/domain/types';

/** One locale for the server and the browser, so that the page that the server renders is the page that hydrates. */
const locale = 'en-GB';

export const fmt = (value: number) => value.toLocaleString(locale);

export const time = (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour12: false });

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', hour12: false });

/** The readable name of each source type. */
export const typeLabels: Record<LeadSourceType, string> = {
  new_acquisition: 'New acquisition',
  business_closure: 'Business closure',
  mutation: 'Mutation',
};
