import { expect, test } from 'vitest';

import { AppPasswordNotRead, GmailLoginRefused } from './gmail';

test('a keychain failure keeps its reason, and shows the message of the script', () => {
  const reason = new Error('security: SecKeychainSearchCopyNext: The specified item could not be found.');
  const error = new AppPasswordNotRead({ reason });

  expect(error._tag).toBe('AppPasswordNotRead');
  expect(error.reason).toBe(reason);
  expect(error.message).toBe('No password in the keychain item leads-gmail-smtp');
});

test('a refused login keeps its reason, and shows it in the message', () => {
  const reason = new Error('Invalid login: 535 5.7.8 Username and Password not accepted');
  const error = new GmailLoginRefused({ reason });

  expect(error._tag).toBe('GmailLoginRefused');
  expect(error.reason).toBe(reason);
  expect(error.message).toBe(
    'Gmail refused the login: Error: Invalid login: 535 5.7.8 Username and Password not accepted'
  );
});
