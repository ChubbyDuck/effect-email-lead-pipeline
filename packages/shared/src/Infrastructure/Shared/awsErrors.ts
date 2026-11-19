/** The SDK gives the error code of an AWS service or of a credential provider as the error name. */
export const nameOf = (reason: unknown) => (reason instanceof Error ? reason.name : undefined);

const authenticationErrors = new Set([
  'CredentialsProviderError',
  'UnrecognizedClientException',
  'ExpiredTokenException',
  'InvalidSignatureException',
]);

/** The AWS credentials are missing, expired, or wrong, so a new sign-in fixes the call. */
export const isAuthenticationFailure = (reason: unknown) => authenticationErrors.has(nameOf(reason) ?? '');
