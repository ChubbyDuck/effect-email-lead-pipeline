# @leads/alchemy

The Alchemy stack of the pipeline: the resources of `LeadsStack` (iac/cdk), made by [Alchemy](https://alchemy.run/) v2 from the same contract (`@leads/shared/deployments`, `@leads/shared/names`, the shared settings) and the same Lambda bundle of `@leads/lambda`. The [spike report](../../docs/design/alchemy-spike.md) has what Alchemy could and could not do before this package existed. A deployment with an `inboxAddress` receives email through its own rule in the shared rule set `leads-mail` of the mail stack, and `alchemy deploy` prints the DKIM and MX records of its domain ([ADR 0003](../../docs/adr/0003-one-shared-ses-rule-set.md)).

Each Alchemy deployment of [deployments.ts](../../packages/shared/src/Infrastructure/Shared/deployments.ts) is one stage of the Alchemy stack `LeadsStack`, with the deployment name as the stage: `production-alchemy`, `local-alchemy`, and `e2e-alchemy`.

| Deployment | Where | State | When it is destroyed |
| --- | --- | --- | --- |
| `production-alchemy` | the AWS project, eu-north-1 | `AWS.state()`: the table `alchemy-state` and its bucket | The buckets and the tables stay (`RemovalPolicy.retain()`), as the CDK stack keeps them. |
| `local-alchemy` | the Floci of `pnpm floci:alchemy:up`, on port 4568 | the DynamoDB of that Floci | Everything goes, with the objects of the buckets. `floci:alchemy:down` removes the Floci, the stack, and the state. |
| `e2e-alchemy` | the Floci of the e2e suite | in memory, for one run ([the e2e app](#the-e2e-app)) | The Floci of the run goes at its end. |

## One-time setup

Do these steps once, before the first deploy of `production-alchemy`. Put the values of your AWS project in `deployments.local.json` at the root of the repo first ([ADR 0004](../../docs/adr/0004-real-deployment-values-in-a-local-file.md)). In the commands, `<profile>` is your AWS profile.

1. On each machine that deploys, make an Alchemy profile with the name of your AWS profile. The root scripts pass `--profile $AWS_PROFILE` to Alchemy, so the two names must be equal. The Alchemy profile holds no secret: it names the AWS profile, and `aws login` keeps the session.

   ```sh
   pnpm exec alchemy profile create <profile>
   pnpm exec alchemy profile edit --profile <profile> --add AWS --method console-login --set loginProfile=<profile>
   ```

   Alchemy writes the profile to `~/.alchemy/profiles/<profile>/aws.json`. `AWS_PROFILE` alone does not work.

2. For the account, make the assets bucket of the Lambda code.

   ```sh
   pnpm exec alchemy provider aws bootstrap --aws-profile <profile> --region eu-north-1
   ```

3. For the account, make the state store of `production-alchemy`.

   ```sh
   pnpm exec alchemy state bootstrap --backend aws --profile <profile>
   ```

Run the commands in this folder. Before you run them, sign in with `aws login`.

## Commands

Run them from the root of the repo. `DEPLOYMENT` selects the deployment, and the root script runs the task of the tool of that deployment (`scripts/infra.mjs`).

| Command | What it does |
| --- | --- |
| `DEPLOYMENT=production-alchemy pnpm infra:diff` | `alchemy deploy --dry-run`: the plan, with no change |
| `DEPLOYMENT=production-alchemy pnpm infra:deploy` | `alchemy deploy`, with the Alchemy profile `$AWS_PROFILE` |
| `pnpm floci:alchemy:up` | Starts the Floci of `local-alchemy` ([compose.local-alchemy.yaml](../../compose.local-alchemy.yaml)) |
| `DEPLOYMENT=local-alchemy pnpm infra:deploy:floci` | Deploys `local-alchemy` into that Floci |
| `DEPLOYMENT=local-alchemy pnpm infra:destroy` | `alchemy destroy`: removes the stage |
| `DEPLOYMENT=local-alchemy pnpm lab:local`, `pnpm dashboard:local` | The web apps on `local-alchemy` |
| `pnpm test:integration` | Also runs the plan tests of this package (below) |
| `pnpm infra:mail:diff` | The plan of [the mail stack](#the-mail-stack), with no change |
| `pnpm infra:mail:deploy` | Deploys the mail stack, with the Alchemy profile `$AWS_PROFILE` |

A deploy into Floci needs the Floci image of Alchemy (`ghcr.io/alchemy-run/floci:2.4.0-alchemy.3`). The image of the repo (`pnpm floci:up`) lacks `DescribeContributorInsights`, which `DynamoDB.Table` calls. `alchemy deploy` ignores `AWS_ENDPOINT_URL`, so the stack gives the providers and the state store the endpoint of the Floci itself ([target.ts](src/target.ts)): `http://127.0.0.1:<flociPort>` of the deployment, or `FLOCI_ENDPOINT` when it is set. The state of a Floci deployment is in the DynamoDB of its Floci, as the state of `production-alchemy` is in AWS, so the lab reads both in the same way. The handlers reach the Floci as `http://floci:4566`, in the Docker network of its Compose project. `FLOCI_LAMBDA_ENDPOINT`, when set, takes the place of that endpoint.

`pnpm infra:destroy` destroys a Floci deployment without a question. For `production-alchemy` it asks for approval, which a run through Turborepo cannot give. To destroy `production-alchemy`, run this in this folder:

```sh
pnpm exec alchemy destroy --stage production-alchemy --profile "$AWS_PROFILE"
```

## The e2e app

[src/e2e/alchemy.run.ts](src/e2e/alchemy.run.ts) is the e2e app: the stage `e2e-alchemy`, with the same additions as the CDK e2e app (`iac/cdk/src/e2e/app.ts`). It deploys the e2e bundle of `@leads/lambda` (`lambdaBundle.e2e`), adds the `e2e` bucket, gives each handler read and write access to it, and sets `E2E_BUCKET_NAME` and `INBOX_SENDER_WHITELIST` on each handler. The prefix comes from `LEADS_BUCKET_PREFIX` when it is set.

`pnpm test:e2e:alchemy` deploys it to a Floci image of Alchemy of its own ([e2e/test-e2e-floci.sh](../../e2e/test-e2e-floci.sh)) and runs the e2e suite. The state is in memory, because each run starts a new Floci.

## The mail stack

[src/mail/alchemy.run.ts](src/mail/alchemy.run.ts) is the mail stack `LeadsMail`, with the one stage `mail` (`mailNames` of `names.ts`). SES has one active receipt rule set for each Region, so the deployments share the rule set `leads-mail`, and each deployment adds its own rule to it. The mail stack owns the rule set and its activation, and nothing else. It is in the AWS project only, with its state in `AWS.state()`, as `production-alchemy` has.

- The activation (`SES.ActiveReceiptRuleSet`) makes `leads-mail` the active rule set of eu-north-1. `SetActiveReceiptRuleSet` swaps the active rule set in one call.
- `RemovalPolicy.protect()` is on the rule set and on the activation. A plan that deletes or replaces one of them fails with `ProtectedResource`, before it changes anything.
- A different stage fails before anything is planned.
- `alchemy destroy` of the mail stack fails, and must fail: the rule set holds the rules of the other stacks, and the delete of the activation stops the email of every deployment.

## The plan test

`test:integration` ([test-integration.sh](test-integration.sh)) starts the Floci image of Alchemy on port 4570, in the Compose project `leads-alchemy-integration` ([compose.integration.yaml](compose.integration.yaml)), and stops it at the end. [mail/stack.integration.test.ts](src/mail/stack.integration.test.ts) plans the mail stack in the same way. [stack.integration.test.ts](src/stack.integration.test.ts) runs `Alchemist.plan` for `e2e-alchemy` with in-memory state, and checks the props and the bindings of each planned resource against the shared settings and `resourceNames`. The plan reads the cloud, so the test needs a Floci. It applies nothing.

## What each stack owns

The CDK stack and the Alchemy stack run at the same time and share no data ([ADR 0002](../../docs/adr/0002-iac-tools-side-by-side.md)). The table shows `production-cdk` and `production-alchemy` with the example values of `deployments.ts`.

| Resource | CDK (`production-cdk`) | Alchemy (`production-alchemy`) | Shared? |
| --- | --- | --- | --- |
| Buckets, queues, DLQs, tables, AppConfig application and strategy | prefix `example-leads` | prefix `example-leads-alchemy` | no: `resourceNames(prefix)` |
| Lambda functions, roles, log groups, mappings | in the CloudFormation stack | in the Alchemy state | no |
| Deploy state | stack `LeadsStack-example-leads` | table `alchemy-state`, stage `production-alchemy` | no |
| Bootstrap | stack `CDKToolkit` and its asset bucket | `alchemy-state` and `alchemy-assets-<account>-<region>-an` | no |
| SES identity, DKIM, and MX | `cdk.ses.example.com` | `alchemy.ses.example.com` | no |
| SES receipt rule | its own rule | its own rule | no |
| SES active rule set | — | — | **yes, by AWS design.** The mail stack owns `leads-mail` ([ADR 0003](../../docs/adr/0003-one-shared-ses-rule-set.md)). |
| Lambda concurrency of the account | 300 reserved | 300 reserved | one pool for the account |

## What Alchemy adds

Alchemy adds parts that the CDK stack does not have ([spike report](../../docs/design/alchemy-spike.md)):

- each function: the variables `ALCHEMY_STACK_NAME`, `ALCHEMY_STAGE`, `ALCHEMY_PHASE`, and `NODE_OPTIONS=--enable-source-maps`, the managed policy `AWSLambdaBasicExecutionRole`, and an inline policy that denies `logs:CreateLogGroup`;
- the log group of each function, which Alchemy makes before the first invocation, with the retention of `handlerSettings.logRetentionDays` (CDK makes a log group of the stack for each function);
- the assets bucket `alchemy-assets-<account>-<region>-an`, shared by every Alchemy stack of the account.
