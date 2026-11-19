/**
 * How AWS counts the units that it bills, and the services that bill them. The prices of the units are in `./prices`.
 * The monitor and the simulation both bill with these rules, so a modeled cost and a real cost differ only by their
 * quantities.
 */

/** The AWS services the stack pays for, in the fixed order a split lists and stacks them. */
export const services = ['Lambda', 'S3', 'SQS', 'SES', 'DynamoDB', 'CloudWatch Logs'] as const;
export type Service = (typeof services)[number];

/** One price by service. A service that is not in the split costs nothing. */
export type ServiceSplit = Partial<Record<Service, number>>;

/** AWS bills a GB as 2^30 bytes. */
const gb = 1024 ** 3;

/** Bytes as the GB that AWS bills. */
export const gigabytesOf = (bytes: number) => bytes / gb;

/** Lambda bills the memory of a function in GB of 1024 MB. */
export const memoryGb = (memoryMb: number) => memoryMb / 1024;

/** Lambda bills each started ms. */
export const billedSeconds = (ms: number) => Math.ceil(ms) / 1000;

/** The GB-seconds that Lambda bills for a run of `ms` at `memoryMb`. */
export const gbSecondsOf = (ms: number, memoryMb: number) => billedSeconds(ms) * memoryGb(memoryMb);

/** SES bills received mail in chunks of 256 KB, headers and attachments included. */
export const sesChunkBytes = 256 * 1024;

/** The SES chunks of an email of this size: each started chunk of 256 KB, and at least one. */
export const sesChunksOf = (bytes: number) => Math.max(1, Math.ceil(bytes / sesChunkBytes));

/** DynamoDB bills each 1 KB of an item as one write request unit. */
export const dynamoWriteUnitBytes = 1024;

export function addSplits(...splits: readonly ServiceSplit[]): ServiceSplit {
  const total: ServiceSplit = {};
  for (const split of splits)
    for (const service of services) {
      const cost = split[service];
      if (cost !== undefined) total[service] = (total[service] ?? 0) + cost;
    }
  return total;
}

export function scaleSplit(split: ServiceSplit, factor: number): ServiceSplit {
  const scaled: ServiceSplit = {};
  for (const service of services) {
    const cost = split[service];
    if (cost !== undefined) scaled[service] = cost * factor;
  }
  return scaled;
}

/** The services of a split in the fixed order, with their share of the split. Services that cost nothing are left out. */
export function splitShares(split: ServiceSplit) {
  const total = services.reduce((sum, service) => sum + (split[service] ?? 0), 0);
  return services
    .filter((service) => (split[service] ?? 0) > 0)
    .map((service) => {
      const cost = split[service] ?? 0;
      return { service, cost, share: total > 0 ? cost / total : 0 };
    });
}
