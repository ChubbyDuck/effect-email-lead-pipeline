import { type DeadLetters, deadLettersOf } from '#Core/Observation/Domain/dlq';
import { type Assessment, assessmentOf } from '#Core/Observation/Domain/health';
import type { Section, Snapshot } from '#Core/Observation/Domain/snapshot';
import type { DlqSource } from '#Core/Observation/Ports/DlqSource';
import type { StatusSource } from '#Core/Observation/Ports/StatusSource';

import type { Command } from './command';

export type StatusResult =
  | (Assessment & {
      readonly ok: true;
      /** The DLQ messages of each request, so that the page can tell them from the messages in a main queue. */
      readonly deadLetters: Section<DeadLetters>;
    })
  | { readonly ok: false; readonly error: string };

export type Ports = {
  readonly status: StatusSource;
  readonly dlq: DlqSource;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads only the DLQs that have messages in the snapshot. A read leaves each message in its DLQ. */
async function deadLettersIn(snapshot: Snapshot, dlq: DlqSource): Promise<Section<DeadLetters>> {
  if (!snapshot.queues.ok) return { ok: false, error: snapshot.queues.error };
  const stages = snapshot.queues.value
    .filter((queue) => queue.role === 'dlq' && queue.visible + queue.inFlight + queue.delayed > 0)
    .map((queue) => queue.stage);
  try {
    const dlqs = await Promise.all(stages.map((stage) => dlq.peek(stage)));
    return { ok: true, value: deadLettersOf(dlqs) };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** Reads one snapshot of the window and assesses it. A failed read of a DLQ fails only the section of the dead letters. */
export async function handler({ windowHours }: Command, { status, dlq }: Ports): Promise<StatusResult> {
  try {
    const snapshot = await status.read(windowHours);
    const deadLetters = await deadLettersIn(snapshot, dlq);
    return { ok: true, ...assessmentOf(snapshot), deadLetters };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}
