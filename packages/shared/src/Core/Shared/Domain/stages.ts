export type StageName = 'inbox' | 'leadSources' | 'leads';

export const stageNames: readonly StageName[] = ['inbox', 'leadSources', 'leads'];

export const stageLabels: Record<StageName, string> = { inbox: 'Inbox', leadSources: 'Lead sources', leads: 'Leads' };

/** The part of a resource name that names its stage, such as `lead-sources` in `<prefix>-lead-sources-dlq`. */
export const stageSlugs: Record<StageName, string> = { inbox: 'inbox', leadSources: 'lead-sources', leads: 'leads' };
