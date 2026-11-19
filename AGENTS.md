# Leads

The leads pipeline: an inbound email with workbooks becomes stored orders, through three AWS Lambda handlers, S3, and SQS. Two web apps watch it: the [lab](apps/lab) and the [dashboard](apps/dashboard). The repo is a pnpm + Turborepo workspace (see [One hexagon per app](#one-hexagon-per-app-one-shared-kernel)). The domain language is in [CONTEXT.md](CONTEXT.md), and the navigation handbook for driving the Lab (Monitor, Burst Simulator, Comparison) and the Orders dashboard is in [docs/lab-handbook.md](docs/lab-handbook.md).

The project started as the folder `apps/leads` of a larger monorepo. A link or a ticket that names `apps/leads/…` or `pnx chubby leads …` means the root of this repo and `pnpm …`.

A file that git ignores, `AGENTS.local.md`, can hold the instructions of one machine, such as the AWS profile and the sign-in of the owner. Read it when it exists.

## What are my engineering values and principles?

I tend to have a strict structural approach to engineering. I always want a system described purely by its Domain Language: a clean set of Entities (or Actors) that can be in certain relations to each other, act on each other, and act together within use cases.

I like Hexagonal (Ports & Adapters) architecture a lot. It feels to me the most versatile approach: it can be applied to any application and to any style of programming, not necessarily to OOP.

My own interpretation of this architecture is:

- **Domain** sits at the core of the system. It is represented as pure language-native constructs — objects, types, classes, and functions — that operate purely on that set.
- **Service layer**, represented by pure Interfaces (Driven Adapters). These describe certain complex operations on entities, which could have different implementations. The most common example is Repositories: simple storages of entities.
- **Use case layer** (controllers, or Driving Adapters). This is the high-level API of the system: endpoints that would use certain implementations of the services to operate on domain models and achieve certain results. Usually represented as a triad: command + handle + action. Some sort of DI is implied, to wire each use case to the correct implementations.
- **UI layer** — I'm not sure "UI" is the best term here. What I mean is that a given use case can be accessed from a CLI, an HTTP API, or some other wrapper that converts raw protocol-based input into a command, which is then handled by the action.

A frontend is usually just connected to the backend using an HTTP API (REST / tRPC / GraphQL — it doesn't really matter which).

## Testing

Testing in these architecture is trivial. Domain entities can be trivially checked using unit tests. Services can have their mock implementations. Use cases can be tested fully mocked (as they depend only on interfaces). For the shape of a use case suite, load the `effect-use-case-tests` skill.

## Effect source

When working with Effect (`effect`, `@effect/*`), read the source of the installed version: `node_modules/effect/src` of the package that uses it, or the [Effect repo](https://github.com/Effect-TS/effect) on GitHub. Do not guess APIs from types or docs when the source is available.

## Tickets, Plans & Specs

**This repo has no external issue tracker.** Whenever a skill or workflow says to "publish to the project issue tracker", "create a GitHub issue", or "apply a triage label", write a file instead. Never run `gh issue create`.

| Artifact | Location | Naming |
| --- | --- | --- |
| **Ticket** — one unit of agent work | `.agents/tickets/` | `NN-slug.md`, continuing that folder's sequence |
| **Plan / PRD** | `.agents/plans/` | `NNNN-slug.md`, continuing that folder's sequence |
| **Tech spec** | `.agents/specs/` | `NNNN-slug.md` |
| **Handoff** — next-session brief | `.agents/handoffs/` | `slug.md` |
| **ADR** — a decision that is hard to reverse, surprising without context, and the result of a real trade-off | `docs/adr/` | `NNNN-slug.md`, continuing that folder's sequence |
| **Loop log** — what a `loop` run (the ticket loop, see the `ticket-loop` skill) leaves for the owner: deviations, deferred work, unfixed findings | `.agents/loop-logs/` | `<run start, UTC>.md`, one per run; holds the follow-up work, in place of new tickets |

Store `/handoff` documents in `.agents/handoffs/`, not in the OS temp directory.

Ticket rules:

- One file per ticket, declaring its blocking edges. Do not create or update a `README.md`, index, dependency table, or other aggregate ticket file.
- Triage labels become body fields: write `**Status:** ready-for-agent` in the ticket rather than applying a label.
- Reference the plan or spec the ticket was generated from.
- When an agent completes a ticket, move the file into `.agents/tickets/done/`.

## Commands

Run the scripts of the root [package.json](package.json) from the repo root as `pnpm <script>`, such as `pnpm test:integration` or `pnpm infra:deploy:floci`. Give the user commands in the same form. Most scripts call `turbo run <task> --filter=@leads/<package>`.

| Script | What it does |
| --- | --- |
| `typecheck`, `test` | The task in every package. Turborepo skips a package that did not change. |
| `lint` | `oxlint .` and `sherif` |
| `test:integration` | Starts Floci, then the integration tests (`@leads/pipeline`). The plan test of `@leads/alchemy` starts the Floci image of Alchemy on port 4570 itself. |
| `test:e2e:floci`, `infra:smoke:floci` | The e2e suite, or only its `E2E-OK` case, on the CDK stack (`e2e-cdk`), against a Floci of its own |
| `test:e2e:alchemy`, `infra:smoke:alchemy` | The same cases on the Alchemy stack (`e2e-alchemy`), against a Floci image of Alchemy of its own. It can run at the same time as the CDK suite. |
| `infra:diff`, `infra:deploy`, `infra:destroy` | The stack of `DEPLOYMENT` (default `production-cdk`), with the tool of that deployment ([scripts/infra.mjs](scripts/infra.mjs)): `cdk diff` and `cdk deploy`, or `alchemy deploy --dry-run`, `alchemy deploy`, and `alchemy destroy`. `infra:destroy` refuses a CDK deployment. |
| `infra:synth` | The CDK stack of `DEPLOYMENT` (CDK only) |
| `infra:deploy:floci` | The Floci deployment of `DEPLOYMENT` (default `local-cdk`), with its tool: the CDK stack of `local-cdk` into the Floci of `floci:up`, or the Alchemy stack of `local-alchemy` into the Floci of `floci:alchemy:up` |
| `infra:mail:diff`, `infra:mail:deploy` | The mail stack of `iac/alchemy`: the shared SES rule set `leads-mail` of the AWS project, with `alchemy deploy --dry-run` or `alchemy deploy` |
| `floci:up`, `floci:down` | The Floci of `local-cdk`, on port 4566 |
| `floci:alchemy:up`, `floci:alchemy:down` | The Floci of `local-alchemy`: the Floci image of Alchemy on port 4568, in a Compose project of its own. It can run at the same time as the Floci of `local-cdk`. |
| `lab`, `dashboard` | A web app on the deployment of `DEPLOYMENT` (default `production-cdk`) |
| `lab:local`, `dashboard:local` | A web app on the Floci deployment of `DEPLOYMENT` (default `local-cdk`), at the endpoint of its Floci ([scripts/local.mjs](scripts/local.mjs)) |
| `gen`, `send`, `send:local`, `send:production`, `catalog`, `mail` | The generator (`tools/generator`). Its output is in `tools/generator/output/`. `send:local` takes `DEPLOYMENT` as `lab:local` does. |
| `bench:lead-sources-memory` | The bench (`tools/bench`) |

A script runs in the folder of its package, so a relative path in its arguments starts there. Do not add a root script named `deploy`: `pnpm deploy` is a built-in command of pnpm.

`DEPLOYMENT` selects a deployment of [deployments.ts](packages/shared/src/Infrastructure/Shared/deployments.ts). The deployments in AWS hold example values there; `deployments.local.json` at the root (git ignores it) holds the values of the real AWS project (ADR [0004](docs/adr/0004-real-deployment-values-in-a-local-file.md)). A script that reaches AWS needs `AWS_PROFILE`. The deployments are `local-cdk`, `production-cdk`, or `e2e-cdk`, made by CDK, or `local-alchemy`, `production-alchemy`, or `e2e-alchemy`, made by Alchemy (ADR [0002](docs/adr/0002-iac-tools-side-by-side.md)). The `tool` of a deployment names its IaC tool, and `deploymentFor(name, tool)` refuses a deployment of a different tool. `infra:diff`, `infra:deploy`, and `infra:destroy` run the tool of the deployment. `infra:synth` runs CDK only, so it refuses an Alchemy deployment. A Floci deployment has the port of its Floci (`flociPort`), and the scripts reach it at `http://127.0.0.1:<port>` (`flociEndpointOf`). `FLOCI_ENDPOINT` wins when it is set. The [README of iac/alchemy](iac/alchemy/README.md) has the one-time setup of `production-alchemy`.

## Completion Gate

Before considering any implementation task done, run a full check: `pnpm typecheck`, `pnpm lint`, and `pnpm test`. The test suite includes the production builds of the lab and the dashboard. Fix every finding. The job is complete only when all three pass with no remaining issues.

## Autoformatting

Format with `pnpm format:changed`: it runs `oxfmt` on the files that differ from `HEAD` (staged, unstaged, and untracked), and `--check` only reports. Never run `oxfmt` on a folder.

Autoformatting is normal in this repo. Not every file is formatted yet, so running `oxfmt` (or a format-on-save) on a file you touched can reformat lines you did not write. Keep those changes: do not revert them, do not restore files to undo them, and do not mention them as a problem.

## The UI kit is a shadcn monorepo package

[@leads/ui](packages/ui) holds the shadcn parts and the theme of the two web apps. Import a part as `@leads/ui/components/<name>`, such as `@leads/ui/components/button`, and the theme as `@leads/ui/globals.css`. Inside the kit, a part imports `cn` as `#lib/utils`.

Add a new part with the `shadcn` skill: run `pnpm dlx shadcn@latest add <part>` in `apps/lab` or `apps/dashboard`. The `components.json` of the app points its `ui` alias at `@leads/ui/components`, so the CLI writes the part into `packages/ui/src/components/`. Then add the explicit export of the new part to [packages/ui/package.json](packages/ui/package.json). The exports `./components` and `./hooks` name only folders, for the CLI.

## A flyout is a sheet

When the user says "flyout", they mean the `Sheet` component of [sheet.tsx](packages/ui/src/components/sheet.tsx): the panel that slides in at the side of the page, such as [RequestSheet.tsx](apps/lab/src/UI/RequestSheet.tsx). The two words are synonyms. In code, use the name `Sheet`.

## Match the check to the change

A small change is done when the edit is in place. Do not spend a long verification pass on work that is already obvious from the diff. Save a live check for a change whose behavior you cannot see from the code.

## Keep the original failure in every error

An error of this app narrows the set of failures that a caller must handle. It does not hide the cause.

- When you wrap a failure in an error of this app, put the original failure in a public `readonly reason: unknown` field.
- Keep the `reason` unchanged. Do not copy it, convert it to a string, or keep only its message. The `reason` can be any value, not only an `Error`.
- An error that wraps more than one failure keeps all of them, such as `AttachmentsNotStored.failures`.
- The `message` can show the reason with `withReason`. The message does not replace the `reason` field.
- A test of an adapter checks the `reason` with `toBe(original)`, not with `toMatchObject`. See [Storage/live.test.ts](packages/pipeline/src/Infrastructure/Pipeline/Storage/live.test.ts).

## One hexagon per app, one shared kernel

Each app owns its own hexagon (Core, Infrastructure, Entrypoints). A hexagon leaves its app only when a different package needs it: then it is a library. The shared kernel is the library `@leads/shared`. See ADR [0001](docs/adr/0001-one-hexagon-per-app.md).

```
apps/lambda/            @leads/lambda      Entrypoints/Lambda, Entrypoints/LambdaE2E: the handlers and their bundles
apps/lab/               @leads/lab         Core/{Observation,Simulation}, Infrastructure/Observation, Entrypoints/Lab, the UI
apps/dashboard/         @leads/dashboard   Core/Orders, Infrastructure/Orders, Entrypoints/Dashboard, the UI
packages/pipeline/      @leads/pipeline    Core/Pipeline, Infrastructure/Pipeline: the inbox, source, and lead handlers
packages/shared/        @leads/shared      Core/Shared, Infrastructure/Shared, Utils: the shared kernel, the deployments, the names
packages/ui/            @leads/ui          the shadcn kit and the theme
packages/{typescript,vite,vitest}-config   the common configs
iac/cdk/                @leads/cdk         the CDK stack
iac/alchemy/            @leads/alchemy     the Alchemy stack: the same pipeline (ADR 0002), and the mail stack of the shared SES rule set (ADR 0003)
tools/generator/, tools/bench/             the generator and the bench
e2e/                    @leads/e2e         the e2e suite of the deployed pipeline
```

- Each hexagon keeps its layers: `src/Core/<Subdomain>/{Domain,Ports,Application}`, `src/Infrastructure/<Subdomain>/<Port>`, and `src/Entrypoints/<Runtime>`.
- Put a new use case in `Core/<Subdomain>/Application/UseCases/<Name>/` as a `command.ts` and a `handler.ts`, a new port in `Core/<Subdomain>/Ports/`, and its adapter in `Infrastructure/<Subdomain>/<Port>/`.
- A fact that two subdomains use goes into `Core/Shared/Domain` of `@leads/shared`, such as [stages.ts](packages/shared/src/Core/Shared/Domain/stages.ts) or [handlerSettings.ts](packages/shared/src/Core/Shared/Domain/handlerSettings.ts). A subdomain does not import a different subdomain to get a shared fact.
- [names.ts](packages/shared/src/Infrastructure/Shared/names.ts) is the one owner of the resource names: the buckets, the queues and their DLQs, the tables, the stack, and the AppConfig application. The CDK stack, the Alchemy stack, the lab, the dashboard, the generator, and the e2e suite read a name there. Nothing else writes a resource name.
- A composition root keeps the `.server` suffix, such as [Lab/services.server.ts](apps/lab/src/Entrypoints/Lab/services.server.ts). The import protection of each web app checks its `src`, so a client module cannot reach a `.server` file through a plain file of the core. The build tests ([lab](apps/lab/build.test.ts), [dashboard](apps/dashboard/build.test.ts)) guard this.

## Rules of dependency

Packages:

- **An app is not a dependency.** The two exceptions: `@leads/cdk` and `@leads/alchemy` install `@leads/lambda`, to deploy its bundle. Two test-only edges also exist: `@leads/e2e` uses the control types and the e2e bundle of `@leads/lambda`, and the catalog test of `@leads/generator` uses its event parsers.
- **A library is a source package.** Its `exports` point at `.ts` files. Only `@leads/lambda` and the two web apps have a `build`.
- **Explicit subpath exports, no wildcard, no barrel file.** Name an export after what its consumer needs, such as `@leads/shared/domain/stages`. The prefix of an export tells its layer (`domain/`, `ports/`, `application/`, `infrastructure/`, `testing/`), so that the lint can check it. Three contract exports have no prefix: `@leads/pipeline/settings` (Application), `@leads/shared/deployments`, and `@leads/shared/names` (Infrastructure). The lint names them one by one.
- **Inside a package, import with a `#` path**, such as `#Core/Pipeline/Ports/Queue` (the `imports` of each `package.json`). No package uses `compilerOptions.paths`.
- **Across packages, import only `@leads/<name>/<export>`.** Never reach a different package with `../`. The one exception: the root scripts [scripts/infra.mjs](scripts/infra.mjs) and [scripts/local.mjs](scripts/local.mjs) import `deployments.ts` by its path, because the root installs no workspace package. Thus `deployments.ts` imports only built-in modules of Node (`node:fs`, `node:path`), to read the local values file (ADR [0004](docs/adr/0004-real-deployment-values-in-a-local-file.md)).
- **Install each dependency in the package that uses it.** The root has only the tools. The versions of `effect`, React, Vite, Vitest, TypeScript, `@types/node`, and the AWS SDK clients are in the `catalog` of [pnpm-workspace.yaml](pnpm-workspace.yaml); `sherif` keeps the other shared versions equal.

Layers. The lint enforces these rules with `no-restricted-imports` overrides in [.oxlintrc.json](.oxlintrc.json). It checks the `#` paths and the `@leads/*` exports. Import a different folder of a package with a `#` path, because the lint does not check `../../`. Test files and `testing` folders are free of the rules.

- Domain imports only its own Domain and the Domain of the shared kernel.
- Ports import the Domain of their subdomain and the shared kernel.
- Application imports its own subdomain and the shared kernel.
- A subdomain imports a different subdomain only through a declared edge. The one edge: Observation imports the Domain of Simulation, for the comparison ([comparison.ts](apps/lab/src/Core/Observation/Domain/comparison.ts), [comparisonSummary.ts](apps/lab/src/Core/Observation/Domain/comparisonSummary.ts), and the CompareRequest use case). Simulation never imports Observation.
- Infrastructure imports Ports and Domain. It never imports Application or Entrypoints.
- Only Entrypoints import a protocol library, such as `aws-lambda` or `@tanstack/react-start`.
- The UI of a web app imports the Entrypoints of its own runtime and the Domain. It never imports Ports, Infrastructure, or a composition root.
- The lab installs `@leads/pipeline` only for the contract test [sourceCharges.test.ts](apps/lab/src/Core/Simulation/Domain/sourceCharges.test.ts). Code of the lab outside tests never imports it.

Two rules that the lint cannot fully check:

- **A use case never calls a different use case.** When a page needs two use cases in sequence, the driving adapter calls them in that sequence, such as the hook [useSimulation.ts](apps/lab/src/UI/Simulator/useSimulation.ts) that calls CompareRequest and then SimulateBurst. The lint catches an import of a different use case through a `#` path only.
- **The UI calls a use case directly only when the use case has no ports.** A composition root binds ports to adapters, and a use case without ports has nothing to bind. Today these are SimulateBurst and CompareRequest, both in the lab, and the lint allows only these two. A new use case without ports needs a new exception in the lint. A use case with ports goes through the Entrypoints of its runtime: do not add an entry point that binds nothing.
