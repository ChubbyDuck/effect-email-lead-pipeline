# The values of a real AWS project in a local file

**Status:** accepted (19 Nov 2026).

The repo is public. Before this decision, [deployments.ts](../../packages/shared/src/Infrastructure/Shared/deployments.ts) held the account, the inbox addresses, the prefixes, and the sender whitelist of the live deployments. A public inbox address invites email that costs SES, S3, and Lambda before the guard rejects it, and the account number and the whitelist are personal data. A clone of the repo also needs a place for the values of its own AWS project.

- **`deployments.ts` keeps every deployment, with example values for the deployments in AWS**: the account `123456789012`, the domain `example.com`, the prefix `example-leads`, and the sender `owner@example.com`. The table, the names of the deployments, and their tools stay in the code, so the tests and the Floci deployments need nothing more.
- **A file at the root of the repo, `deployments.local.json`, holds the values of one real AWS project.** Git ignores it. [deployments.local.example.json](../../deployments.local.example.json) shows its shape. It can set only `account`, `inboxAddress`, `prefix`, and `senderWhitelist`, and only for a deployment in AWS. An unknown deployment, an unknown field, or a Floci deployment in the file stops the load with an error, so that a typo does not deploy a stack with the example values.
- **`deployments.ts` finds the file itself.** It looks up from the current folder for the root of the workspace (`pnpm-workspace.yaml`). Every reader of the deployments runs in Node from a folder of the repo: the root scripts, the CDK app, the Alchemy app, the lab, the dashboard, the generator, and the e2e suite. Thus no reader changes, and a deploy still reads nothing from the shell except the credentials, `AWS_PROFILE`, and `DEPLOYMENT`.
- **A test sees only the committed values.** Under Vitest (`VITEST` is set), `deployments.ts` does not read the file, so the suite gives the same result on each machine.
- **The AWS profile comes from `AWS_PROFILE`, with no default.** A task in AWS without it stops with an error ([scripts/infra.mjs](../../scripts/infra.mjs)). The Alchemy profile has the same name.

## Consequences

`deployments.ts` imports `node:fs` and `node:path`. The root scripts still import it by its path, because Node has these modules without an install. No browser bundle imports `deployments.ts`.

The Turborepo hash of a task does not include the ignored file. Each task that reads a deployment in AWS (`synth`, `diff`, `deploy`, `dev`, `send`) has `cache: false`, so a changed file always takes effect.

A change of the live values is now a change of a local file, not a commit. The owner keeps a copy of the file outside the repo.

## Considered options

- **Environment variables**, such as `LEADS_ACCOUNT` and `LEADS_PREFIX`. Each reader then needs the variables, the strict environment mode of Turborepo needs each one in `turbo.json`, and a missing variable falls back to an example in silence.
- **A `deployments.local.ts` module.** A static import of a file that git ignores fails in a clone, and a dynamic import makes each reader asynchronous.
- **Example values only, and a fork for the real deployment.** The public repo then is not the repo that the owner deploys.
