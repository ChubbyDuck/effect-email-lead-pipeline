# One hexagon per app, in a Turborepo workspace

**Status:** accepted (17 Nov 2026). Plan: [0005-monorepo](../../.agents/plans/0005-monorepo.md).

The repo was one package with "one core" (`src`) for three runtimes. In that core, each subdomain except the shared kernel had exactly one runtime that used it in production: Pipeline for the Lambda handlers, Orders for the dashboard, and Observation and Simulation for the lab. We made the repo a pnpm + Turborepo workspace in which each app owns its own hexagon (Core, Infrastructure, Entrypoints), and the shared kernel is the library `@leads/shared`. The goals are dependency isolation (the Lambda bundle cannot pull React, and a web app cannot pull `aws-cdk-lib`) and independent, cached checks for each package.

**A hexagon leaves its app when a different package needs it.** Turborepo treats an app as the end of the graph: no other package installs it. The Pipeline hexagon has five consumers outside the handlers: the IaC, the generator, the bench, the e2e suite, and one contract test of the lab. Thus the Pipeline hexagon is the library `@leads/pipeline`, and the Lambda runtime is the app `@leads/lambda`. The Orders, Observation, and Simulation hexagons have no outside consumer, so they stay inside their apps. The one permitted exception: an IaC package installs `@leads/lambda`, because it deploys the bundle of that app.

## Consequences

- The edge "Observation imports the Domain of Simulation" is now inside one app (the lab). The edges between subdomains of different packages are the `dependencies` of each `package.json`, not lint rules.
- All libraries are source (just-in-time) packages. Thus no package uses `compilerOptions.paths`: imports inside a package use Node subpath imports (`#Core/…`), and imports across packages use only the explicit `exports` (`@leads/pipeline/settings`, …). The `~` alias is gone.
- The layer rules inside a hexagon (Domain, Ports, Application, Infrastructure, Entrypoints) stay in `.oxlintrc.json`, and they now check `#` paths.
- Two test-only edges also reach `@leads/lambda`: the e2e suite (`@leads/e2e`) uses its e2e bundle and the types of its control file, and one catalog test of `@leads/generator` uses its parsers of S3 and SQS events. Both are `devDependencies`, and no runtime code of a different package imports the app.

## Considered options

- **Keep one core package**, and give each app only its framework code. This is simpler, but every app then depends on every subdomain and every dependency of the core.
- **Keep the Pipeline hexagon inside its app** and let five packages install the app. This breaks the Turborepo rule five times for one subdomain.
