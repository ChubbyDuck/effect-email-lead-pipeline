import type { Email, EmailAuthentication } from '@leads/shared/domain/types';
import { ConfigProvider, Effect, Layer } from 'effect';
import { describe, expect, test } from 'vitest';

import { Guard } from '#Core/Pipeline/Ports/Guard';

import { GuardLive } from './live';

const owner = 'owner@example.com';

/** One From header and a DMARC check that SES passed for the domain of the owner. */
const authenticated: EmailAuthentication = { fromHeaders: 1, dmarc: { verdict: 'pass', domain: 'example.com' } };

const emailFrom = (senders: readonly string[], authentication: EmailAuthentication = authenticated): Email => ({
  attachments: [],
  senders,
  authentication,
});

const guardWith = (whitelist: unknown) =>
  GuardLive.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ INBOX_SENDER_WHITELIST: whitelist })))
  );

const authorize = (senders: readonly string[], authentication?: EmailAuthentication) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const guard = yield* Guard;
      return yield* Effect.exit(guard.authorize(emailFrom(senders, authentication)));
    }).pipe(Effect.provide(guardWith([owner])))
  );

const rejection = (senders: readonly string[], reason: string) => ({
  _tag: 'Failure',
  cause: { reasons: [{ error: { _tag: 'Unauthorized', senders, reason } }] },
});

test('authorizes the whitelisted address and rejects an unlisted sender', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const guard = yield* Guard;
      yield* guard.authorize(emailFrom([owner, owner]));
      return yield* Effect.flip(guard.authorize(emailFrom([owner, 'other@example.org'])));
    }).pipe(Effect.provide(guardWith([owner])))
  );

  expect(result).toMatchObject({ _tag: 'Unauthorized', senders: [owner, 'other@example.org'] });
});

describe('authorizes', () => {
  test.each([[owner], ['Owner@Example.COM'], [`  ${owner}  `]])('%s', async (sender) => {
    expect((await authorize([sender]))._tag).toBe('Success');
  });
});

describe('rejects', () => {
  test.each([
    ['another address on the same domain', 'other@example.com'],
    ['the address before another @', `${owner}@example.org`],
    ['a lookalike domain', `${owner}.example.org`],
    ['a subdomain', 'owner@mail.example.com'],
    ['a plus address', 'owner+leads@example.com'],
    ['a previously whitelisted domain', 'one@example.ch'],
    ['an address without a local part', '@example.com'],
  ])('%s', async (_, sender) => {
    expect(await authorize([sender])).toMatchObject(rejection([sender], 'Sender is outside the whitelist'));
  });

  test('an email without a sender', async () => {
    expect(await authorize([])).toMatchObject(rejection([], 'Email has no sender'));
  });
});

describe('rejects a whitelisted sender that SES does not prove', () => {
  test('an email with more than one From header, before any other check', async () => {
    const twoFromHeaders = { ...authenticated, fromHeaders: 2 };

    expect(await authorize([owner], twoFromHeaders)).toMatchObject(
      rejection([owner], 'Email has more than one From header')
    );
    expect(await authorize(['other@example.org'], twoFromHeaders)).toMatchObject(
      rejection(['other@example.org'], 'Email has more than one From header')
    );
  });

  test('an email without a DMARC result from SES', async () => {
    expect(await authorize([owner], { fromHeaders: 1, dmarc: undefined })).toMatchObject(
      rejection([owner], 'Email is not authenticated by SES')
    );
  });

  test.each(['fail', 'none', 'temperror', 'permerror'] as const)('a DMARC %s', async (verdict) => {
    expect(await authorize([owner], { fromHeaders: 1, dmarc: { verdict, domain: 'example.com' } })).toMatchObject(
      rejection([owner], 'DMARC did not pass for example.com')
    );
  });

  test.each([
    ['another domain', 'example.org'],
    ['a subdomain', 'mail.example.com'],
    ['a parent domain', 'com'],
  ])('a DMARC pass for %s', async (_, domain) => {
    expect(await authorize([owner], { fromHeaders: 1, dmarc: { verdict: 'pass', domain } })).toMatchObject(
      rejection([owner], `DMARC passed for ${domain}, not for example.com`)
    );
  });

  test('a DMARC pass that covers only one of two whitelisted senders', async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const guard = yield* Guard;
        return yield* Effect.exit(guard.authorize(emailFrom([owner, 'other@example.org'])));
      }).pipe(Effect.provide(guardWith([owner, 'other@example.org'])))
    );

    expect(exit).toMatchObject(
      rejection([owner, 'other@example.org'], 'DMARC passed for example.com, not for example.org')
    );
  });
});

describe('authorizes a DMARC pass', () => {
  test('for the sender domain in any case', async () => {
    expect((await authorize(['Owner@Example.COM']))._tag).toBe('Success');
    expect((await authorize([owner], { fromHeaders: 1, dmarc: { verdict: 'pass', domain: 'Example.COM' } }))._tag).toBe(
      'Success'
    );
  });

  test('for every sender on the same domain', async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const guard = yield* Guard;
        return yield* Effect.exit(guard.authorize(emailFrom([owner, 'other@example.com'])));
      }).pipe(Effect.provide(guardWith([owner, 'other@example.com'])))
    );

    expect(exit._tag).toBe('Success');
  });
});

describe('reads the whitelist from config', () => {
  test('matches a configured address in any case and with whitespace', async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const guard = yield* Guard;
        return yield* Effect.exit(
          guard.authorize(
            emailFrom(['other@example.org'], { ...authenticated, dmarc: { verdict: 'pass', domain: 'example.org' } })
          )
        );
      }).pipe(Effect.provide(guardWith([`  ${owner}`, 'Other@Example.ORG '])))
    );

    expect(exit._tag).toBe('Success');
  });

  test('accepts a comma-separated whitelist from the environment', async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const guard = yield* Guard;
        return yield* Effect.exit(guard.authorize(emailFrom([owner, 'other@example.com'])));
      }).pipe(
        Effect.provide(
          GuardLive.pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { INBOX_SENDER_WHITELIST: `${owner},other@example.com` } })
              )
            )
          )
        )
      )
    );

    expect(exit._tag).toBe('Success');
  });

  test('rejects every sender when the whitelist is empty', async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const guard = yield* Guard;
        return yield* Effect.exit(guard.authorize(emailFrom([owner])));
      }).pipe(Effect.provide(guardWith([])))
    );

    expect(exit).toMatchObject({ _tag: 'Failure' });
  });

  test('fails to build without a whitelist', async () => {
    const exit = await Effect.runPromiseExit(
      Guard.pipe(Effect.provide(GuardLive.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))))))
    );

    expect(exit).toMatchObject({ _tag: 'Failure', cause: { reasons: [{ error: { _tag: 'ConfigError' } }] } });
  });

  test('fails to build when an entry is not an address', async () => {
    const exit = await Effect.runPromiseExit(Guard.pipe(Effect.provide(guardWith(['not an address']))));

    expect(exit).toMatchObject({ _tag: 'Failure', cause: { reasons: [{ error: { _tag: 'ConfigError' } }] } });
  });
});
