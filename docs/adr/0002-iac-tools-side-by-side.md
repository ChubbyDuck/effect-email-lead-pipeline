# IaC tools side by side, as separate deployments

**Status:** accepted (17 Nov 2026).

The stack is in CDK, and we want to try a second IaC tool (Alchemy or Pulumi). For a transition period, both stacks must work at the same time and share no data, so that we can deploy the app with each tool and compare the results. Thus `iac/` is a namespace with one package for each tool (`iac/cdk` first), and the target of a deploy, of the lab, and of the dashboard is a **deployment**: one complete copy of the pipeline, made by one tool in one place.

- **A flat list of deployments**, such as `local-cdk`, `production-cdk`, and `e2e-cdk`. `DEPLOYMENT=<name>` selects one. Each deployment has its own prefix and inbox address. A flat list names only the pairs of place and tool that exist (no Pulumi on Floci, for example). Two variables, `ENVIRONMENT` × `IAC`, would also name pairs that do not exist.
- **One tool-neutral contract** in `@leads/shared`: the list of deployments and the naming rules (`<prefix>-orders`, `<prefix>-leads-dlq`, …). Every IaC package and every app reads this contract. Before this decision, the CDK stack and the adapters of the lab each wrote the names.
- **Tool-neutral facts do not live in an IaC package.** The runtime settings schema belongs to `@leads/pipeline`, and the bundle belongs to `@leads/lambda`.
- `production-cdk` keeps the prefix `example-leads` and the stack ID `LeadsStack-example-leads`, so the move changes no live resource.

## Consequences

SES is not per stack. A Region has one active receipt rule set, and a domain has one identity. When the second stack comes, a small account-level part outside both stacks will own the active rule set. Each stack then has its own subdomain, its own identity, its own MX record, and its own receipt rule in that rule set. We delay this split until a second stack exists. Today, the rule set lives in the CDK stack, and its removal deactivates all rule sets (`onDelete` of the activation), so an early split costs a window without email and gives nothing.

**Superseded in part by [ADR 0003](0003-one-shared-ses-rule-set.md) (18 Nov 2026).** The split is done: the Alchemy mail stack owns the shared rule set `leads-mail`. `production-cdk` did not keep `noreply@ses.example.com`: it receives on `noreply@cdk.ses.example.com`, and `production-alchemy` receives on `noreply@alchemy.ses.example.com`.

## Considered options

- **Swap only** (`iac/cdk` now, a different tool later in its place). This needs no contract, but it does not let the two stacks run at the same time.
- **Only one stack receives email**, and the other stack gets emails by a direct put into its inbox bucket. That stack then has no real inbox to compare.
- **Each stack activates its own rule set.** The last deploy then takes the email from the other stack without a warning.
