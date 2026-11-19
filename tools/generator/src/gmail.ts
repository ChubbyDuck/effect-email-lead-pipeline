import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Data, Effect, Layer, Redacted } from 'effect';
import { createTransport } from 'nodemailer';

import { Mailer, WaveNotSent } from './waves';

const keychainItem = 'leads-gmail-smtp';

/** `security` did not read the app password of Gmail from the keychain. The `reason` tells why. */
export class AppPasswordNotRead extends Data.TaggedError('AppPasswordNotRead')<{
  readonly reason: unknown;
}> {
  override get message(): string {
    return `No password in the keychain item ${keychainItem}`;
  }
}

/** Gmail did not accept the sender and the app password. */
export class GmailLoginRefused extends Data.TaggedError('GmailLoginRefused')<{
  readonly reason: unknown;
}> {
  override get message(): string {
    return `Gmail refused the login: ${String(this.reason)}`;
  }
}

/** Gmail shows an app password in groups with spaces, and takes it without them. */
const readAppPassword = Effect.tryPromise({
  try: () => promisify(execFile)('security', ['find-generic-password', '-s', keychainItem, '-w']),
  catch: (reason) => new AppPasswordNotRead({ reason }),
}).pipe(Effect.map(({ stdout }) => Redacted.make(stdout.replaceAll(/\s/g, ''))));

/** A login that fails stops the script here, before the first email. */
export const gmailMailer = ({ inboxAddress, sender }: { readonly inboxAddress: string; readonly sender: string }) =>
  Layer.effect(
    Mailer,
    Effect.gen(function* () {
      const password = yield* readAppPassword;
      const transport = createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: sender, pass: Redacted.value(password) },
      });
      yield* Effect.tryPromise({
        try: () => transport.verify(),
        catch: (reason) => new GmailLoginRefused({ reason }),
      });
      return {
        send: ({ filename, content, subject }) =>
          Effect.tryPromise({
            try: () =>
              transport.sendMail({
                from: sender,
                to: inboxAddress,
                subject,
                text: subject,
                attachments: [{ filename, content }],
              }),
            catch: (reason) => new WaveNotSent({ filename, reason }),
          }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                console.log(`${new Date().toISOString()} ${subject}: ${filename}`);
              })
            )
          ),
      };
    })
  );
