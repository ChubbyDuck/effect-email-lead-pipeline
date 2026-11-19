import { stageSlugs, type StageName } from '#Core/Shared/Domain/stages';

/**
 * The names of the resources of one deployment: the one owner of these names (ADR 0002). Every IaC package and every
 * app reads a name here, and nothing else writes one.
 */
export function resourceNames(prefix: string) {
  return {
    /** The CloudFormation stack. */
    stack: `LeadsStack-${prefix}`,
    /** The bucket that a stage reads from. The leads stage has no bucket. */
    bucket: (stage: Exclude<StageName, 'leads'>) => `${prefix}-${stageSlugs[stage]}`,
    queue: (stage: StageName) => `${prefix}-${stageSlugs[stage]}`,
    dlq: (stage: StageName) => `${prefix}-${stageSlugs[stage]}-dlq`,
    /** The CloudWatch alarm that goes off when the dead-letter queue of a stage holds a message. */
    dlqAlarm: (stage: StageName) => `${prefix}-${stageSlugs[stage]}-dlq-not-empty`,
    /**
     * The Lambda function of a stage. Only Alchemy uses it: the CDK stack keeps its generated names, because a new
     * name replaces the live function.
     */
    functionName: (stage: StageName) => `${prefix}-${stageSlugs[stage]}`,
    ordersTable: `${prefix}-orders`,
    requestLedgerTable: `${prefix}-request-ledger`,
    appConfigApplication: prefix,
    appConfigDeploymentStrategy: `${prefix}-at-once`,
    /** The receipt rule of the deployment in the shared rule set of the mail stack (`mailNames.ruleSet`). */
    mailRule: `${prefix}-inbox`,
    /** The bucket of the e2e suite: the control file of the harness and what the e2e adapters observe. */
    e2eBucket: `${prefix}-e2e`,
  };
}

export type ResourceNames = ReturnType<typeof resourceNames>;

/**
 * The Alchemy stack of the pipeline. Each Alchemy deployment is one Alchemy stage of it, with its own state. "Stage"
 * is the term of Alchemy here (`--stage`), not a stage of the pipeline (`StageName`).
 */
export const alchemyPipeline = {
  stack: 'LeadsStack',
  /** The Alchemy stage of a deployment is its name, as `deploymentFor(name, 'alchemy')` accepts it. */
  stage: (deploymentName: string) => deploymentName,
} as const;

/**
 * The mail stack: the one SES receipt rule set of the account and its activation. AWS permits one active rule set for
 * each Region, so the deployments share it, and its names have no prefix. Each deployment adds its own rule to it.
 */
export const mailNames = {
  /** The SES receipt rule set that each deployment adds its rule to. */
  ruleSet: 'leads-mail',
  /** The Alchemy stack that owns the rule set. */
  stack: 'LeadsMail',
  /** The one Alchemy stage of the mail stack. */
  stage: 'mail',
} as const;
