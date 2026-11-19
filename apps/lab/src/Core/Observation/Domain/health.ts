import { stageLabels, type StageName } from '@leads/shared/domain/stages';

import { dollars, lambdaPrice } from './costs';
import { type Levels, withLevels } from './levels';
import { peak, total, type Section, type Snapshot } from './snapshot';
import { span } from './time';

export type Level = 'critical' | 'warning' | 'info';

/** The resource of the pipeline that a finding is about. A finding about the whole stack or a section has none. */
export type Place =
  | { readonly stage: StageName; readonly part: 'bucket' | 'queue' | 'handler' | 'dlq' }
  | { readonly stage: 'orders'; readonly part: 'table' };

export interface Finding {
  readonly level: Level;
  readonly subject: string;
  readonly message: string;
  readonly place?: Place;
}

/** An object that stays in a stage bucket longer than this did not go through its handler. */
export const stuckObjectAgeSeconds = 15 * 60;
/** A queue whose oldest visible message is older than this has a backlog. */
export const backlogAgeSeconds = 5 * 60;
/** A handler whose longest run passes this part of its timeout is near the timeout. */
export const timeoutShare = 0.8;

const rank: Record<Level, number> = { critical: 0, warning: 1, info: 2 };

export const overall = (findings: readonly Finding[]): Level | 'ok' =>
  findings.reduce<Level | 'ok'>(
    (worst, { level }) => (worst === 'ok' || rank[level] < rank[worst] ? level : worst),
    'ok'
  );

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The verb that agrees with a count, such as `waits` for 1 and `wait` for more. */
const verb = (count: number, one: string, many: string) => (count === 1 ? one : many);

function unread(name: string, section: Section<unknown>): Finding[] {
  return section.ok ? [] : [{ level: 'warning', subject: name, message: `Cannot read: ${section.error}` }];
}

/** The problems that a snapshot shows, the worst first. */
export function assess(snapshot: Snapshot, now: Date): Finding[] {
  const findings: Finding[] = [
    ...unread('Stack', snapshot.deploymentStatus),
    ...unread('Handlers', snapshot.handlers),
    ...unread('Queues', snapshot.queues),
    ...unread('Buckets', snapshot.buckets),
    ...unread('Orders table', snapshot.orders),
    ...unread('Runtime settings', snapshot.settings),
    ...unread('Logs', snapshot.logs),
  ];
  const add = (level: Level, subject: string, message: string, place?: Place) =>
    findings.push({ level, subject, message, ...(place !== undefined && { place }) });
  const window = `in the last ${plural(snapshot.windowHours, 'hour')}`;

  if (snapshot.deploymentStatus.ok) {
    const { name, phase, status, reason } = snapshot.deploymentStatus.value;
    const detail = reason === undefined ? status : `${status}: ${reason}`;
    if (phase === 'failed') add('critical', name, `The stack is in ${detail}.`);
    else if (phase === 'in-progress') add('info', name, `A deployment is in progress (${status}).`);
  }

  const errorsOf = new Map<StageName, number>();
  if (snapshot.handlers.ok) {
    for (const handler of snapshot.handlers.value) {
      const subject = `${stageLabels[handler.stage]} handler`;
      const place: Place = { stage: handler.stage, part: 'handler' };
      const errors = total(handler.errors);
      const throttles = total(handler.throttles);
      const longest = peak(handler.durationMax);
      errorsOf.set(handler.stage, errors);

      if (handler.state !== 'Active') add('critical', subject, `The function is ${handler.state}.`, place);
      if (handler.lastUpdateStatus === 'Failed') {
        add('critical', subject, 'The last update of the function failed.', place);
      }
      if (handler.mapping.state !== 'Enabled') {
        add(
          'critical',
          subject,
          `The queue trigger is ${handler.mapping.state}, so the handler gets no messages.`,
          place
        );
      }
      if (errors > 0) add('warning', subject, `${plural(errors, 'invocation')} failed ${window}.`, place);
      if (throttles > 0) {
        add(
          'warning',
          subject,
          `${plural(throttles, 'invocation')} ${verb(throttles, 'was', 'were')} throttled ${window}.`,
          place
        );
      }
      if (longest >= handler.timeoutSeconds * 1000 * timeoutShare) {
        add(
          'warning',
          subject,
          `The longest run took ${(longest / 1000).toFixed(1)} s of the ${handler.timeoutSeconds} s timeout, for ${dollars(lambdaPrice(longest, handler.memoryMb).cost)} = ${lambdaPrice(longest, handler.memoryMb).formula}.`,
          place
        );
      }
    }
  }

  if (snapshot.queues.ok) {
    const queues = snapshot.queues.value;
    for (const queue of queues) {
      if (queue.role === 'dlq') {
        const count = queue.visible + queue.inFlight + queue.delayed;
        if (count > 0) {
          add(
            'critical',
            queue.name,
            `${plural(count, 'message')} failed and ${verb(count, 'waits', 'wait')} for a redrive.`,
            { stage: queue.stage, part: 'dlq' }
          );
        }
        continue;
      }
      const place: Place = { stage: queue.stage, part: 'queue' };
      if (queue.visible > 0 && (queue.oldestAgeSeconds ?? 0) > backlogAgeSeconds) {
        add(
          'warning',
          queue.name,
          `${plural(queue.visible, 'message')} ${verb(queue.visible, 'waits', 'wait')}. ` +
            `The oldest is ${span(queue.oldestAgeSeconds ?? 0)} old.`,
          place
        );
      }
      if (queue.inFlight > 0 && (errorsOf.get(queue.stage) ?? 0) > 0) {
        const dlq = queues.find((other) => other.stage === queue.stage && other.role === 'dlq');
        add(
          'warning',
          queue.name,
          `${plural(queue.inFlight, 'message')} in flight after a failed invocation. ` +
            `When the visibility timeout of ${span(queue.visibilityTimeoutSeconds)} ends, ` +
            `${verb(queue.inFlight, 'it moves', 'they move')} to ${dlq?.name ?? 'the DLQ'}.`,
          place
        );
      }
    }
  }

  if (snapshot.buckets.ok) {
    for (const bucket of snapshot.buckets.value) {
      const ageOf = (lastModified: string) => (now.getTime() - Date.parse(lastModified)) / 1000;
      const stuck = bucket.objects.filter((object) => ageOf(object.lastModified) > stuckObjectAgeSeconds);
      const oldest = stuck.at(-1);
      if (oldest !== undefined) {
        add(
          'warning',
          bucket.name,
          `${plural(stuck.length, 'object')} older than ${span(stuckObjectAgeSeconds)} ` +
            `(the oldest ${span(ageOf(oldest.lastModified))}). A handler keeps an object only when it fails.`,
          { stage: bucket.stage, part: 'bucket' }
        );
      }
    }
  }

  if (snapshot.orders.ok) {
    const orders = snapshot.orders.value;
    const place: Place = { stage: 'orders', part: 'table' };
    if (orders.status !== 'ACTIVE') add('critical', orders.name, `The table is ${orders.status}.`, place);
    const throttles = total(orders.throttles);
    if (throttles > 0) {
      add(
        'warning',
        orders.name,
        `${plural(throttles, 'write')} ${verb(throttles, 'was', 'were')} throttled ${window}.`,
        place
      );
    }
  }

  if (snapshot.settings.ok) {
    const { environmentState, deployment } = snapshot.settings.value;
    if (environmentState === 'ROLLED_BACK') {
      add('critical', 'Runtime settings', 'AppConfig rolled back the last deployment.');
    }
    if (deployment === undefined) add('warning', 'Runtime settings', 'AppConfig has no deployment.');
    else if (deployment.state !== 'COMPLETE') {
      add(
        deployment.state === 'ROLLED_BACK' ? 'critical' : 'info',
        'Runtime settings',
        `Deployment ${deployment.number} is ${deployment.state}.`
      );
    }
  }

  if (snapshot.logs.ok) {
    const warnings = snapshot.logs.value.filter((event) => event.level === 'warn').length;
    if (warnings > 0) add('info', 'Logs', `${plural(warnings, 'warning')} ${window}.`);
  }

  return findings.toSorted((a, b) => rank[a.level] - rank[b.level]);
}

/** The status of the pipeline at one time: a snapshot, its findings, and the worst level of the findings. */
export interface Assessment {
  readonly snapshot: Snapshot;
  readonly findings: readonly Finding[];
  readonly overall: Level | 'ok';
  /** The time of the counts of the queues and the buckets, when they are newer than the snapshot. */
  readonly countsAt?: string;
}

/**
 * The assessment of a snapshot with the counts of the levels, at the time of the newest counts. Levels that are older
 * than the snapshot change nothing.
 */
export function assessmentOf(snapshot: Snapshot, levels?: Levels): Assessment {
  const newer = levels !== undefined && levels.readAt > snapshot.collectedAt ? levels : undefined;
  const current = newer === undefined ? snapshot : withLevels(snapshot, newer);
  const findings = assess(current, new Date(newer?.readAt ?? snapshot.collectedAt));
  return {
    snapshot: current,
    findings,
    overall: overall(findings),
    ...(newer !== undefined && { countsAt: newer.readAt }),
  };
}
