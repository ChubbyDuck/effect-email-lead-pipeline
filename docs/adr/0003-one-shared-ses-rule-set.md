# One shared SES rule set, one subdomain for each deployment

**Status:** accepted (18 Nov 2026). It does the split that the "Consequences" of [ADR 0002](0002-iac-tools-side-by-side.md) delayed.

SES has one active receipt rule set for each Region, and a domain has one identity. Two deployments in the same AWS project, `production-cdk` and `production-alchemy`, must each receive real email. Thus the account has one rule set, and each deployment adds its own rule to it.

- **The shared rule set is `leads-mail`** (`mailNames.ruleSet` of [names.ts](../../packages/shared/src/Infrastructure/Shared/names.ts)). The rule set has no deployment prefix, because the account has only one.
- **The owner is the Alchemy mail stack** ([iac/alchemy/src/mail](../../iac/alchemy/src/mail/stack.ts), stack `LeadsMail`, stage `mail`). It owns the rule set and its activation (`SES.ActiveReceiptRuleSet`), and nothing else. Both have `RemovalPolicy.protect()`: a plan that deletes or replaces one of them fails with `ProtectedResource` before it changes anything. Deploy it with `pnpm infra:mail:deploy`.
- **One subdomain, one identity, and one rule for each deployment.** A deployment with an `inboxAddress` in [deployments.ts](../../packages/shared/src/Infrastructure/Shared/deployments.ts) verifies the domain of the address (Easy DKIM) and adds one rule to `leads-mail` by name. The rule is `mailRule` of `resourceNames` (`<prefix>-inbox`), and it scans each email to the address and stores it in the inbox bucket of the deployment. The stack prints the DKIM CNAMEs and the MX record, and the owner adds them by hand, because the DNS of `example.com` is not in Route 53.

  | Deployment | Address | Rule |
  | --- | --- | --- |
  | `production-cdk` | `noreply@cdk.ses.example.com` | `example-leads-inbox` |
  | `production-alchemy` | `noreply@alchemy.ses.example.com` | `example-leads-alchemy-inbox` |

- **The CDK address changed.** `production-cdk` received on `noreply@ses.example.com`. It now receives on `noreply@cdk.ses.example.com` only. The old rule set `example-leads-inbox`, its activation, and the identity `ses.example.com` are gone. The move kept email open at all times: the CDK rule received on both addresses until `leads-mail` was active.

## Consequences

- Deploy the mail stack before a deployment that adds a rule. A rule of a deployment names `leads-mail`, and SES refuses a rule in a rule set that does not exist.
- No rule of `leads-mail` has a stop action, so the order of the rules does not change which deployment receives an email. The Alchemy rule has no `after`, so each Alchemy deploy puts it at the top of the set again.
- When a deploy makes or changes the S3 action of a rule, SES writes a setup notification object (`AMAZON_SES_SETUP_NOTIFICATION`) into the inbox bucket. The inbox handler rejects it, so the lab shows one rejected request at the time of that deploy.
- The removal of a deployment deletes its rule and its identity. It does not change `leads-mail` or its activation, so the email of the other deployment continues.
- Do not deactivate `leads-mail` from a different stack or by hand. The activation is the one switch for the email of every deployment.

## Considered options

- **The CDK stack keeps the rule set**, and the Alchemy stack adds its rule to it. The Alchemy deployment then depends on a resource of the CDK deployment, and the removal of the CDK stack deactivates every rule set (`onDelete` of the CDK activation).
- **Each stack activates its own rule set.** The last deploy then takes the email from the other deployment without a warning.
- **One subdomain for all deployments**, with one rule for each address. The deployments then share one identity, so neither stack can own it.
- **The mail stack in CDK.** The activation of CDK is a custom resource whose `onDelete` deactivates every rule set. `SES.ActiveReceiptRuleSet` of Alchemy swaps the active set in one `SetActiveReceiptRuleSet` call, and `protect()` stops its delete.
