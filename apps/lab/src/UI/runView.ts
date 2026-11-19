import type { RequestProgress } from '@leads/shared/domain/request';
import type { StageName } from '@leads/shared/domain/stages';

/** What the sheet of a request shows of its runs: the text of each progress write and the timeline of the runs. */
import type { HandlerRun, RunOutcome } from '#Core/Observation/Domain/runs';
import { runTrailOf } from '#Core/Observation/Domain/trail';

import type { Tone } from './Tag';

export interface Step {
  readonly text: string;
  readonly tone: Tone;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The steps of one progress write, in the words of the page. A write that ends work moves it from pending to an
 * outcome, so the negative pending part says nothing more and has no step.
 */
export function stepsOf(change: RequestProgress): Step[] {
  const steps: Step[] = [];
  const status = change.inboxStatus;
  if (status === 'pending') steps.push({ text: 'email received', tone: 'info' });
  if (status === 'processed') steps.push({ text: 'email processed', tone: 'ok' });
  if (status === 'rejected') steps.push({ text: 'email rejected', tone: 'warning' });
  if (status === 'failed') steps.push({ text: 'email failed', tone: 'critical' });
  const {
    attachments,
    sourcesPending = 0,
    sourcesLeads = 0,
    sourcesProcessed = 0,
    sourcesRejected = 0,
    sourcesFailed = 0,
    leadsPending = 0,
    leadsProcessed = 0,
    leadsRejected = 0,
    leadsFailed = 0,
  } = change;
  if (attachments !== undefined) steps.push({ text: plural(attachments, 'attachment'), tone: 'neutral' });
  if (sourcesPending > 0) steps.push({ text: 'source started', tone: 'info' });
  if (sourcesLeads > 0) steps.push({ text: `${plural(sourcesLeads, 'lead')} found`, tone: 'neutral' });
  if (sourcesProcessed > 0) steps.push({ text: 'source processed', tone: 'ok' });
  if (sourcesRejected > 0) steps.push({ text: 'source rejected', tone: 'warning' });
  if (sourcesFailed > 0) steps.push({ text: 'source failed', tone: 'critical' });
  if (leadsPending > 0) steps.push({ text: `${plural(leadsPending, 'lead')} taken`, tone: 'info' });
  if (leadsProcessed > 0) steps.push({ text: `${plural(leadsProcessed, 'lead')} stored`, tone: 'ok' });
  if (leadsRejected > 0) steps.push({ text: `${plural(leadsRejected, 'lead')} rejected`, tone: 'warning' });
  if (leadsFailed > 0) steps.push({ text: `${plural(leadsFailed, 'lead')} failed`, tone: 'critical' });
  return steps;
}

/** The steps of the progress writes of one request in a run, in the order that the run wrote them. */
export const runStepsOf = (run: HandlerRun, requestID: string): Step[] =>
  runTrailOf(run, requestID).changes.flatMap(({ change }) => stepsOf(change));

/** The outcome of a run in the words and the color of the page. Logged errors make an ended run a problem too. */
export function runStateOf(run: HandlerRun): readonly [tone: Tone, text: string] {
  const states: Record<RunOutcome, readonly [Tone, string]> = {
    running: ['info', 'running'],
    failed: ['critical', 'failed'],
    timeout: ['critical', 'timed out'],
    ended: run.errors > 0 ? ['warning', 'ended with errors'] : ['ok', 'ended'],
  };
  return states[run.outcome];
}

/** In ms. The end of a run, or `now` for a run that has no end yet. */
export const runEndOf = (run: HandlerRun, now: number) =>
  run.endedAt === undefined ? Math.max(now, Date.parse(run.startedAt)) : Date.parse(run.endedAt);

export interface Bar {
  readonly run: HandlerRun;
  /** The share of the axis before the bar, from 0 to 1. */
  readonly left: number;
  /** The share of the axis that the bar covers. */
  readonly width: number;
  /** The row of the lane. Runs that overlap go in different rows. */
  readonly row: number;
}

export interface Lane {
  readonly stage: StageName;
  readonly rows: number;
  readonly bars: readonly Bar[];
}

export interface Timeline {
  /** In ms. */
  readonly start: number;
  readonly end: number;
  readonly lanes: readonly Lane[];
}

/**
 * The runs on one axis of time, one lane for each stage. The axis starts when the email came in, or at the first run,
 * and ends at the end of the last run. Each run goes in the first row of its lane that is free at its start.
 */
export function timelineOf(
  stages: readonly { readonly stage: StageName; readonly runs: readonly HandlerRun[] }[],
  receivedAt: string | undefined,
  now: number
): Timeline | undefined {
  const runs = stages.flatMap(({ runs }) => runs);
  if (runs.length === 0) return undefined;
  const starts = runs.map((run) => Date.parse(run.startedAt));
  const start = Math.min(...starts, ...(receivedAt === undefined ? [] : [Date.parse(receivedAt)]));
  const end = Math.max(...runs.map((run) => runEndOf(run, now)), start + 1);
  const length = end - start;

  const lanes = stages.map(({ stage, runs }): Lane => {
    const rowEnds: number[] = [];
    const bars = runs
      .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((run): Bar => {
        const runStart = Date.parse(run.startedAt);
        const runEnd = runEndOf(run, now);
        const free = rowEnds.findIndex((rowEnd) => rowEnd <= runStart);
        const row = free === -1 ? rowEnds.length : free;
        rowEnds[row] = runEnd;
        return { run, left: (runStart - start) / length, width: (runEnd - runStart) / length, row };
      });
    return { stage, rows: Math.max(rowEnds.length, 1), bars };
  });
  return { start, end, lanes };
}
