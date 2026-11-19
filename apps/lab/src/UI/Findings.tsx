import { Skeleton } from '@leads/ui/components/skeleton';
import { cn } from '@leads/ui/lib/utils';

import type { Finding, Level } from '#Core/Observation/Domain/health';

import { type Tone, toneText } from './Tag';

export const levelTone: Record<Level | 'ok', Tone> = {
  critical: 'critical',
  warning: 'warning',
  info: 'info',
  ok: 'ok',
};

const surface: Record<Level, string> = {
  critical: 'bg-crit-soft',
  warning: 'bg-warn-soft',
  info: 'bg-live-soft',
};

const mark: Record<Level, string> = { critical: 'bg-crit', warning: 'bg-warn', info: 'bg-live' };

const levelNoun: Record<Level, readonly [one: string, many: string]> = {
  critical: ['critical', 'critical'],
  warning: ['warning', 'warnings'],
  info: ['note', 'notes'],
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The counts of each level, the worst first, such as `1 critical, 2 warnings`. */
export function breakdown(findings: readonly Finding[]) {
  return (['critical', 'warning', 'info'] as const)
    .flatMap((level) => {
      const count = findings.filter((finding) => finding.level === level).length;
      return count === 0 ? [] : [`${count} ${levelNoun[level][count === 1 ? 0 : 1]}`];
    })
    .join(', ');
}

/**
 * The verdict of the last snapshot and the counts of the findings that make it. A finding about one resource shows on
 * its box on the map, so the list below the counts has only the findings about the whole stack or a section.
 */
export function FindingList({
  findings,
  overall,
  windowHours,
}: {
  /** No findings while the first snapshot loads. */
  readonly findings: readonly Finding[] | undefined;
  readonly overall: Level | 'ok' | undefined;
  readonly windowHours: number;
}) {
  if (findings === undefined || overall === undefined) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-14" />
      </div>
    );
  }

  const unplaced = findings.filter((finding) => finding.place === undefined);
  return (
    <div className="flex flex-col gap-3">
      <p>
        <span className={cn('font-extrabold', toneText[levelTone[overall]])}>
          {findings.length === 0 ? 'No problems found' : `${plural(findings.length, 'thing')} to look at`}
        </span>{' '}
        <span className="text-muted-foreground">
          {findings.length === 0
            ? `Every resource reads as healthy for the last ${windowHours} h.`
            : breakdown(findings)}
        </span>
      </p>
      {unplaced.length > 0 && (
        <ul className="grid gap-3 md:grid-cols-[repeat(auto-fit,minmax(380px,1fr))]">
          {unplaced.map((finding, index) => (
            <li key={index} className={cn('flex items-start gap-3 rounded-xl px-3.5 py-3', surface[finding.level])}>
              <span className={cn('mt-1.5 size-2.5 flex-none rounded-[3px]', mark[finding.level])} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span
                    className={cn(
                      'text-[11px] font-extrabold tracking-wider uppercase',
                      toneText[levelTone[finding.level]]
                    )}
                  >
                    {finding.level}
                  </span>
                  <span className="font-mono text-[13px] font-semibold break-all">{finding.subject}</span>
                </div>
                <p className="text-foreground/80">{finding.message}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
