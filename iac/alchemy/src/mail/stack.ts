import * as AWS from '@alchemy.run/aws';
import { mailNames } from '@leads/shared/names';
import * as RemovalPolicy from 'alchemy/RemovalPolicy';
import * as Effect from 'effect/Effect';

/**
 * The mail stack: the shared SES receipt rule set `leads-mail` and its activation. AWS permits one active rule set for
 * each Region, so the deployments share it, and each deployment adds its own rule to it. The stack owns the rule set
 * and its activation, and nothing else.
 *
 * The stack protects both: a plan that deletes or replaces one of them fails with `ProtectedResource`, before it
 * changes anything. The rule set holds the rules of the other stacks, and the delete of the activation stops the email
 * of every deployment.
 */
export const leadsMail = Effect.gen(function* () {
  const ruleSet = yield* AWS.SES.ReceiptRuleSet('RuleSet', { ruleSetName: mailNames.ruleSet }).pipe(
    RemovalPolicy.protect()
  );
  // `SetActiveReceiptRuleSet` swaps the active rule set in one call, so no email is lost in the swap.
  yield* AWS.SES.ActiveReceiptRuleSet('Activation', { ruleSetName: ruleSet.ruleSetName }).pipe(RemovalPolicy.protect());
});
