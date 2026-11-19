/**
 * The list prices of the Region that the stack deploys to. The monitor prices the runs in the logs with them, and the
 * simulation prices a modeled burst with them, so a modeled cost and a real cost differ only by their quantities.
 * EU (Stockholm), from the AWS Price List API. The prices exclude the free tier, taxes, and data transfer.
 */
export const prices = {
  region: 'eu-north-1',
  readAt: '2026-10-13',
  /** Lambda: $0.20 per million calls. */
  lambdaRequest: 0.0000002,
  /** Lambda x86: per GB-second, for the first 6 billion GB-seconds of a month. */
  lambdaGbSecond: 0.0000166667,
  /** SQS standard queue: $0.40 per million calls. */
  sqsRequest: 0.0000004,
  /** S3 Standard: $0.005 per 1,000 PUT calls. */
  s3Put: 0.000005,
  /** S3 Standard: $0.0004 per 1,000 GET calls. A DELETE is free. */
  s3Get: 0.0000004,
  /** S3 Standard: per GB-month, for the first 50 TB of a month. */
  s3StorageGbMonth: 0.023,
  /** SES receiving: $0.10 per 1,000 emails. */
  sesEmail: 0.0001,
  /** SES receiving: $0.09 per 1,000 chunks of 256 KB. */
  sesChunk: 0.00009,
  /** DynamoDB on-demand: $0.67 per million write request units. */
  dynamoWriteUnit: 0.00000067,
  /** DynamoDB on-demand: $0.1345 per million read request units. */
  dynamoReadUnit: 0.0000001345,
  /** DynamoDB Standard: per GB-month, after the first 25 GB of the account. */
  dynamoStorageGbMonth: 0.269,
  dynamoFreeStorageGb: 25,
  /** CloudWatch Logs Standard: per GB that a log group takes in. */
  logIngestGb: 0.54,
  /** CloudWatch Logs: per GB-month that a log group keeps. */
  logStorageGbMonth: 0.028,
  /** CloudWatch: $0.01 per 1,000 metrics that GetMetricData requests. */
  metricRequested: 0.00001,
} as const;
