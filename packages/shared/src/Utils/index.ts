export function balance<T>(items: readonly T[], capacity: number): T[][] {
  const batches: T[][] = [];
  items.forEach((item, index) => {
    (batches[index % capacity] ??= []).push(item);
  });
  return batches;
}

export function insertBetween<T>(array: T[], separator: T) {
  return array.flatMap((element, index) => (index ? [separator, element] : [element]));
}

const encode = (s: string) => encodeURIComponent(s).replace(/%2F/g, '$252F');
export function buildCloudwatchUrl(data: { region: string; lambda: string }) {
  let url = `https://${data.region}.console.aws.amazon.com/cloudwatch/home?region=${encode(
    data.region
  )}#logsV2:log-groups/log-group/${encode(`/aws/lambda/${data.lambda}`)}`;

  return url;
}

export const withReason = (message: string, reason: unknown) =>
  `${message} due to: ${reason instanceof Error ? reason.message : 'unknown reason'}`;

// export function buildS3BucketUrl(bucket: string, prefix?: string) {
//   return `https://${getEnvironment().aws.region}.console.aws.amazon.com/s3/buckets/${bucket}${
//     prefix ? `?prefix=${prefix}` : ''
//   }`;
// }
