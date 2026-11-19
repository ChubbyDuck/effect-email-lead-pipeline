/**
 * Sends each file of a folder to the inbox address of a deployment as one real email from Gmail, in the order of the
 * file names. The emails go through Gmail and SES, so the pipeline sees them as any other email.
 *
 *   [DEPLOYMENT=<name>] pnpm mail <folder> [--every <seconds>]
 *
 * `DEPLOYMENT` names a deployment with an inbox address, `production-cdk` by default.
 *
 * The script runs in `tools/generator`, so a relative `<folder>` starts there, such as `output/catalog/1-email-attachments`.
 *
 * `--every` is the time from the start of one email to the start of the next, 60 by default. The script logs in to
 * Gmail before the first email. The app password comes from the macOS keychain:
 *
 *   security add-generic-password -a <sender> -s leads-gmail-smtp -w
 */
import { parseArgs } from 'node:util';

import { defaultDeployment, deploymentNamed } from '@leads/shared/deployments';
import { Effect } from 'effect';

import { gmailMailer } from './gmail';
import { readWaves, sendWaves } from './waves';

/** The inbox address and the sender of the deployment `name`. A deployment without an inbox address receives no email. */
const recipientOf = (name: string) => {
  const { inboxAddress, senderWhitelist } = deploymentNamed(name);
  if (inboxAddress === undefined) throw new Error(`The deployment ${name} has no inbox address.`);
  return { inboxAddress, sender: senderWhitelist[0] };
};

const parseSeconds = (value: string) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`--every must be a number of seconds. Got: ${value}`);
  return seconds;
};

try {
  const { values, positionals } = parseArgs({
    options: { every: { type: 'string', default: '60' } },
    allowPositionals: true,
  });
  const folder = positionals.at(-1);
  if (folder === undefined) throw new Error('Give the folder of the files to send.');
  const every = parseSeconds(values.every);
  const recipient = recipientOf(process.env.DEPLOYMENT ?? defaultDeployment);

  await Effect.runPromise(
    readWaves(folder).pipe(
      Effect.flatMap((waves) => sendWaves(waves, `${every} seconds`)),
      Effect.provide(gmailMailer(recipient))
    )
  );
} catch (error) {
  console.log(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
