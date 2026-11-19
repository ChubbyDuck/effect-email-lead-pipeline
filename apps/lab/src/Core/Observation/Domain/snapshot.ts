/**
 * One reading of the deployed leads workflow: the state of each resource of the stack at one time.
 * A section that the source cannot read holds its error, so one failed call does not hide the other sections.
 */

import type { StageName } from '@leads/shared/domain/stages';

export type Section<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const messageOf = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** The value of a read, or its error. */
export async function section<T>(read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** Values in equal periods, oldest first. A period without a datapoint holds 0. */
export interface Series {
  readonly start: string;
  readonly periodSeconds: number;
  readonly values: readonly number[];
}

/** The IaC tool that made the deployment. */
export type DeploymentTool = 'cdk' | 'alchemy';

export const toolLabels: Record<DeploymentTool, string> = { cdk: 'CDK', alchemy: 'Alchemy' };

/** The state of a deployment in the words of no tool. The health rules read it, not the words of the tool. */
export type DeploymentPhase = 'complete' | 'in-progress' | 'failed';

/** The status of the deployment, as its IaC tool keeps it. */
export interface DeploymentStatus {
  readonly tool: DeploymentTool;
  /** The CloudFormation stack, or the Alchemy stack and stage. */
  readonly name: string;
  readonly phase: DeploymentPhase;
  /** The status in the words of the tool, for display. */
  readonly status: string;
  readonly reason?: string;
  /** The time of the last change. A tool that does not keep it can leave it out. */
  readonly updatedAt?: string;
}

export interface HandlerStatus {
  readonly stage: StageName;
  readonly functionName: string;
  readonly state: string;
  readonly lastUpdateStatus: string;
  readonly lastModified: string;
  readonly timeoutSeconds: number;
  readonly memoryMb: number;
  readonly reservedConcurrency?: number;
  readonly mapping: {
    readonly state: string;
    readonly batchSize: number;
    readonly maximumConcurrency?: number;
  };
  readonly invocations: Series;
  readonly errors: Series;
  readonly throttles: Series;
  /** In ms. */
  readonly durationMax: Series;
  readonly concurrencyMax: Series;
}

export interface QueueStatus {
  readonly name: string;
  readonly url: string;
  readonly stage: StageName;
  readonly role: 'main' | 'dlq';
  readonly visible: number;
  readonly inFlight: number;
  readonly delayed: number;
  readonly visibilityTimeoutSeconds: number;
  readonly retentionSeconds: number;
  /** The receives of a message before it moves to the DLQ. Only a queue with a DLQ has it. */
  readonly maxReceiveCount?: number;
  /** The last value of `ApproximateAgeOfOldestMessage`. */
  readonly oldestAgeSeconds?: number;
  readonly sent: Series;
}

export interface StoredObject {
  readonly key: string;
  readonly lastModified: string;
  readonly size: number;
}

export interface BucketStatus {
  readonly name: string;
  readonly stage: StageName;
  /** Every object, newest first. A handler deletes each object that it processed or rejected, so an object here waits or failed. */
  readonly objects: readonly StoredObject[];
  /** True when the bucket has more objects than the source listed. */
  readonly truncated: boolean;
}

export interface TableStatus {
  readonly name: string;
  readonly status: string;
  /** DynamoDB updates this value about every six hours. */
  readonly itemCount: number;
  readonly sizeBytes: number;
  readonly writes: Series;
  readonly throttles: Series;
}

/** A value that JSON can hold, such as the content of a configuration. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

export interface SettingsStatus {
  readonly environmentState: string;
  readonly deployment?: {
    readonly number: number;
    readonly state: string;
    readonly version: string;
    readonly startedAt: string;
    readonly completedAt?: string;
  };
  readonly content?: Json;
}

export interface LogEvent {
  readonly stage: StageName;
  readonly time: string;
  readonly level: 'error' | 'warn';
  readonly requestId?: string;
  readonly message: string;
}

export interface HandlerUsage {
  readonly stage: StageName;
  readonly memoryMb: number;
  readonly invocations: number;
  /** In ms. The sum of the durations of the runs, without their init time. */
  readonly durationMs: number;
  readonly logGroup: string;
  /** The log bytes that the handler wrote in the window. */
  readonly logBytes: number;
  /** The log bytes that the log group keeps now. */
  readonly logStoredBytes: number;
}

export interface QueueUsage {
  readonly name: string;
  readonly stage: StageName;
  readonly role: 'main' | 'dlq';
  readonly sent: number;
  readonly received: number;
  readonly deleted: number;
  /** The receives that got no message: the polls of the trigger on an empty queue. */
  readonly emptyReceives: number;
}

export interface TableUsage {
  readonly name: string;
  /** The orders that the lead handlers store, or the ledger that every handler writes and the lab reads. */
  readonly role: 'orders' | 'ledger';
  readonly readUnits: number;
  readonly writeUnits: number;
  readonly sizeBytes: number;
}

/** What the stack used in the window, as CloudWatch counts it. The costs of the window come from it. */
export interface Usage {
  readonly handlers: readonly HandlerUsage[];
  readonly queues: readonly QueueUsage[];
  readonly tables: readonly TableUsage[];
  /** The bytes of each email that the inbox read in the window, one for each key, from its size lines. */
  readonly emailBytes: readonly number[];
  /** The CloudWatch metrics that one read of a snapshot requests. Each one costs money. */
  readonly metricsPerRead: number;
}

export interface Snapshot {
  readonly deployment: string;
  readonly region: string;
  /** The address that SES receives into the inbox bucket. An environment without it receives no email. */
  readonly inboxAddress?: string;
  readonly collectedAt: string;
  readonly windowHours: number;
  readonly deploymentStatus: Section<DeploymentStatus>;
  readonly handlers: Section<readonly HandlerStatus[]>;
  readonly queues: Section<readonly QueueStatus[]>;
  readonly buckets: Section<readonly BucketStatus[]>;
  readonly orders: Section<TableStatus>;
  readonly settings: Section<SettingsStatus>;
  /** Newest first. */
  readonly logs: Section<readonly LogEvent[]>;
  readonly usage: Section<Usage>;
}

export const total = (series: Series) => series.values.reduce((sum, value) => sum + value, 0);

export const peak = (series: Series) => series.values.reduce((max, value) => Math.max(max, value), 0);
