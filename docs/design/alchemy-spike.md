# The Alchemy Spike

**Status:** completed (17–18 Nov 2026), validated on both Floci and AWS (`eu-north-1`).  
**Context:** Spike report run before [`iac/alchemy`](../../iac/alchemy) existed, to verify whether [Alchemy](https://alchemy.run/) v2 could deploy the exact same stack side by side with AWS CDK ([ADR 0002](../adr/0002-iac-tools-side-by-side.md)). For the current production stack and setup instructions, see [`iac/alchemy/README.md`](../../iac/alchemy/README.md).

---

## Verdict: Go

Every "must-have" check passed. Alchemy v2 (`alchemy@2.0.0-beta.87` and `@alchemy.run/aws@2.0.0-beta.87`) can provision every resource in `LeadsStack` from the shared contract — using the prebuilt `@leads/lambda` bundles and the resource names in [`names.ts`](../../packages/shared/src/Infrastructure/Shared/names.ts).

The spike ran in an isolated scratch folder with a one-stage slice of the pipeline (an S3 bucket notifying an SQS queue with a DLQ, DynamoDB Orders table, the full AppConfig chain, the prebuilt `leads` Lambda bundle + event source mapping, and an SES receipt rule). It deployed 14 resources to a local Floci instance on port `4569` (every setting verified via AWS CLI), then deployed, invoked, and cleanly destroyed the same stack in AWS (`eu-north-1`, prefix `leads-spike-alchemy`).

---

## Questions answered by the spike

| # | Question | Finding |
| --- | --- | --- |
| 1 | **Effect version compatibility** | **Yes.** Both packages require `effect ^4.1.4`, matching our workspace catalog (`4.1.4`). |
| 2 | **Prebuilt Lambda bundles** | **Yes.** `Lambda.Function` with `main: '<bundle>/<stage>/index.js'`, `bundle: false`, `handler: 'handler'` deploys the bundle as-is (`index.handler`). Direct invocation ran our code cleanly. |
| 3 | **Explicit resource names** | **Yes.** Supports `bucketName`, `queueName`, `tableName`, `functionName`, `applicationName`, `deploymentStrategyName`, and `ruleSetName`. |
| 4 | **S3 → SQS notifications** | **Yes, via bindings.** `queue.bind(sid, { policyStatements })` allows `s3.amazonaws.com`, and `bucket.bind(sid, { notificationConfiguration: { QueueConfigurations } })` wires the notification. |
| 5 | **AppConfig seed & validator** | **Yes.** `Application`, `Environment`, `ConfigurationProfile` (`JSON_SCHEMA` validator), `HostedConfigurationVersion`, `DeploymentStrategy` (0 min, factor 100, bake 0), and `Deployment` (`configurationVersion: Output.map(version.versionNumber, String)`). Changing the seed creates a new version and triggers a rollout. |
| 6a | **SES receipt in `eu-north-1`** | **Yes.** `SES.ReceiptRuleSet` and `SES.ReceiptRule` deployed and deleted cleanly alongside the then-active CDK rule set `example-leads-inbox` (later replaced by the shared `leads-mail` rule set in [ADR 0003](../adr/0003-one-shared-ses-rule-set.md)). `SES.ReceiptRule` enforces no hardcoded Region restriction. |
| 6b | **Cross-stack SES rule** | **Yes.** `SES.ReceiptRule` accepts `ruleSetName` as a plain string, so each pipeline stack can add its rule to a shared mail stack's rule set. |
| 6c | **Safe `alchemy destroy` on active rule set** | **Yes, with `RemovalPolicy.protect()`.** `SES.ActiveReceiptRuleSet` only deactivates on delete if its rule set is still active; `RemovalPolicy.protect()` makes `alchemy destroy` refuse the plan (`ProtectedResource`) before touching SES. |
| 7 | **Auth with an AWS CLI profile** | **Yes, via an Alchemy profile.** `AWS_PROFILE` alone fails (*"Provider 'AWS' is not configured in profile 'default'"*). One-time machine setup: `alchemy profile create <profile>` then `alchemy profile edit --profile <profile> --add AWS --method console-login --set loginProfile=<profile>`. It stores no secrets (just references the AWS profile in `~/.alchemy/profiles/<profile>/aws.json`), picks up Region from `~/.aws/config`, and works with `aws login`. |
| 8 | **Reading Alchemy state from the Lab** | **Partially.** `makeDynamoDBState()` from `@alchemy.run/aws` returns a `StateService` (`listStacks`, `listStages`, `list`, `get`) with per-resource statuses and stage catalog status (`active`, `rolled-back`, `destroyed`). **It does not store a last-deploy timestamp.** |
| 9 | **Targeting Floci on a custom port** | **Yes, via `AWSEnvironment` layer** (not `AWS_ENDPOINT_URL`). See below. |
| 10 | **Plan testing without deploying** | **Yes, against Floci.** `Alchemist.plan({ stack, operation: 'deploy', stage })` returns planned resources, props, and bindings without applying changes — though planning reads cloud state, so the test requires a running Floci container. |

---

## Running Alchemy against Floci

- `alchemy deploy` ignores `AWS_ENDPOINT_URL`, so environment-only configuration still targets real AWS.
- `alchemy dev` hardcodes its own Floci on port `4566` (`DEFAULT_FLOCI_PORT`), colliding with `pnpm floci:up`.
- **What works:** provide an explicit `AWS.AWSEnvironment` layer in the stack so `alchemy deploy` can target any Floci endpoint on any port:

```ts
AWS.providers().pipe(
  Layer.provide(
    Layer.succeed(
      AWS.AWSEnvironment,
      Effect.succeed({
        accountId: '000000000000',
        region: 'us-east-1',
        endpoint,
        credentials: Effect.succeed({
          accessKeyId: Redacted.make('test'),
          secretAccessKey: Redacted.make('test'),
          sessionToken: undefined,
          region: 'us-east-1',
        }),
      })
    )
  )
);
```

- **Floci image difference:** The repo's CDK Floci image (`floci/floci@sha256:f5aa8c18…`) lacks `DescribeContributorInsights`, which Alchemy's `DynamoDB.Table` calls. Alchemy's own Floci image (`ghcr.io/alchemy-run/floci:2.4.0-alchemy.3`) supports it and deployed the full stack cleanly.

---

## Key findings & differences from CDK

- **No accidental resource hijacking:** Planning a resource whose name already exists outside Alchemy's stage fails with `OwnedBySomeoneElse` unless `--adopt` is passed, so a misconfigured prefix cannot silently take over CDK resources.
- **Extra Lambda defaults:** Alchemy attaches `ALCHEMY_STACK_NAME`, `ALCHEMY_STAGE`, `ALCHEMY_PHASE`, and `NODE_OPTIONS=--enable-source-maps` to each function, grants `AWSLambdaBasicExecutionRole`, and adds an inline policy denying `logs:CreateLogGroup` while creating the log group itself (with no retention by default — our stack sets `handlerSettings.logRetentionDays`).
- **Explicit SQS IAM permissions:** `EventSourceMapping` sets `batchSize`, `maximumBatchingWindow`, `functionResponseTypes`, and `scalingConfig.MaximumConcurrency`, but unlike CDK it does not auto-grant `sqs:ReceiveMessage` / `DeleteMessage` / etc. Our stack binds those explicitly via `fn.bind(sid, { policyStatements })`.
- **Bootstrap requirements on AWS:** Functions fail with *"Assets bucket not found"* until `alchemy provider aws bootstrap` creates `alchemy-assets-<account>-<region>-an`, and remote state requires `alchemy state bootstrap --backend aws` (creating `alchemy-state` and its overflow bucket).
- **Resilience & speed on AWS:** The 14-resource spike deployed in ~40 s (mostly DynamoDB + waiting for the SQS mapping to become `Enabled`), planned zero changes on rerun, recovered cleanly from a half-failed initial deploy without duplicating mappings, and tore down in ~10 s (including roles and log groups).
- **Pre-1.0 pinning:** Both packages are `2.0.0-beta.87`; pin exact versions in `iac/alchemy/package.json`.

---

## Design changes that came out of the spike

1. **Dedicated Floci containers:** `local-alchemy` (`4568`) and `e2e-alchemy` (`4569`) run Alchemy's Floci image with the custom `AWSEnvironment` layer, leaving `local-cdk` (`4566`) and `e2e-cdk` (`4567`) untouched. We do not use `alchemy dev`.
2. **Lab deploy timestamp:** Because Alchemy state omits a last-deploy time, the Lab's `alchemyState` adapter derives it from the newest `LastModified` timestamp across the three Lambda functions.
3. **Plan checks as integration tests:** `Alchemist.plan` checks live in `test:integration` against a self-contained Floci on port `4570`, keeping unit tests Docker-free.
4. **Protected shared SES activation:** The mail stack uses `RemovalPolicy.protect()` on `SES.ActiveReceiptRuleSet` so accidental destroys fail at plan time.
5. **Documented one-time setup:** Profile creation, assets bootstrap, and state bootstrap are documented in [`iac/alchemy/README.md`](../../iac/alchemy/README.md).
6. **Account concurrency headroom:** Each deployment reserves 300 concurrent executions (`50 + 50 + 200`), leaving 400 unreserved out of AWS's default 1,000 limit when both `production-cdk` and `production-alchemy` run side by side.

---

## Side-by-side verification: `production-alchemy` vs. `production-cdk`

On **18 Nov 2026**, `production-alchemy` was deployed to `eu-north-1` alongside `production-cdk` (22 resources + 20 bindings in 1 min 26 s; second plan reported no changes; `production-cdk` had only an expected `Code.S3Key` diff from earlier monorepo refactors).

We dropped the same email carrying `new_acquisition.xlsx` (67 leads) into both inbox buckets within 2 ms of each other:

| Deployment | Received | Last ledger update | End-to-end | Stored orders |
| --- | --- | --- | --- | --- |
| `production-cdk` | `07:41:59.936` | `07:42:36.592` | `36.7 s` | 67 new (192 total) |
| `production-alchemy` | `07:41:59.893` | `07:42:34.114` | `34.2 s` | 67 new (67 total) |

- **Zero shared data:** Each deployment wrote only to its own Orders table, Request ledger, buckets, and queues, leaving all queues and DLQs empty.
- **Identical Lab experience:** Both Labs reported every stage as `clear` and Orders as `accepts writes`, displaying tool-native status (`active` for Alchemy, `UPDATE_COMPLETE` for CDK) in the **Stack** tab.
- **Shared contract:** Buckets, queues, DLQs, tables, reserved concurrency, and pipeline outputs matched exactly. Only Lambda function names differ (Alchemy uses `resourceNames().functionName`, while CDK retains its generated names as explained in [`names.ts`](../../packages/shared/src/Infrastructure/Shared/names.ts)).
