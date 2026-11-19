import type { ReactNode } from 'react';

import type { QueueStatus, Snapshot } from '#Core/Observation/Domain/snapshot';

/** Where the lab reads: a deployment has a console only when it is not local. */
type Place = Pick<Snapshot, 'deployment' | 'region'>;

/** A local deployment runs in Floci on this machine, such as `local-cdk`. */
const isLocal = (place: Place) => place.deployment.startsWith('local-');

/** Links to the AWS console. A local deployment has no console, so it shows only the name. */
export function consoleLinks(snapshot: Place) {
  const { region } = snapshot;
  const link = (name: string, href: string): ReactNode =>
    isLocal(snapshot) ? (
      name
    ) : (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="underline decoration-border underline-offset-3 hover:text-primary hover:decoration-primary"
      >
        {name}
      </a>
    );
  return {
    fn: (name: string) =>
      link(
        name,
        `https://${region}.console.aws.amazon.com/lambda/home?region=${region}#/functions/${encodeURIComponent(name)}`
      ),
    queue: (queue: QueueStatus) =>
      link(
        queue.name,
        `https://${region}.console.aws.amazon.com/sqs/v3/home?region=${region}#/queues/${encodeURIComponent(queue.url)}`
      ),
    bucket: (name: string) =>
      link(name, `https://${region}.console.aws.amazon.com/s3/buckets/${encodeURIComponent(name)}?region=${region}`),
  };
}

export type ConsoleLinks = ReturnType<typeof consoleLinks>;

/** One object in the S3 console. No address for a local deployment. */
export function s3ObjectUrl(place: Place, bucket: string, key: string): string | undefined {
  if (isLocal(place)) return undefined;
  const { region } = place;
  return (
    `https://${region}.console.aws.amazon.com/s3/object/${encodeURIComponent(bucket)}` +
    `?region=${region}&bucketType=general&prefix=${encodeURIComponent(key)}`
  );
}

/** The CloudWatch console escapes the parts of its address two times, and writes `$` for `%`. */
const consolePart = (text: string) => encodeURIComponent(encodeURIComponent(text)).replace(/%/g, '$');

/** The lines of one run in the CloudWatch console. No address for a local deployment. */
export function runLogsUrl(place: Place, logGroup: string, logStream: string, runID: string): string | undefined {
  if (isLocal(place)) return undefined;
  const { region } = place;
  return (
    `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/` +
    `${consolePart(logGroup)}/log-events/${consolePart(logStream)}$3FfilterPattern$3D${consolePart(`"${runID}"`)}`
  );
}
