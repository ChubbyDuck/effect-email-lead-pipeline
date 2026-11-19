import { Effect, Layer } from 'effect';

import { Guard, InboxSenderWhitelist, Unauthorized } from '#Core/Pipeline/Ports/Guard';

const normalize = (address: string) => address.trim().toLowerCase();

const domainOf = (address: string) => normalize(address).split('@').pop()!;

/**
 * Only an exact whitelisted address passes, in any case and with whitespace around it.
 * SES does not reject a forged From header, so the email must also have one From header,
 * and the DMARC check that SES reported must pass for the domain of every sender.
 */
export const GuardLive = Layer.effect(
  Guard,
  Effect.gen(function* () {
    const whitelist = new Set((yield* InboxSenderWhitelist).map(normalize));
    const isWhitelisted = (sender: string) => whitelist.has(normalize(sender));

    return {
      authorize: ({ senders, authentication }) => {
        const reject = (reason: string) => Effect.fail(new Unauthorized({ senders, reason }));
        const { dmarc } = authentication;

        // The parser keeps only the last From header, so a second one could hide the real sender.
        if (authentication.fromHeaders > 1) return reject('Email has more than one From header');
        if (senders.length === 0) return reject('Email has no sender');
        if (!senders.every(isWhitelisted)) return reject('Sender is outside the whitelist');
        if (dmarc === undefined) return reject('Email is not authenticated by SES');
        if (dmarc.verdict !== 'pass') return reject(`DMARC did not pass for ${dmarc.domain}`);
        const unaligned = senders.map(domainOf).find((domain) => domain !== normalize(dmarc.domain));
        if (unaligned !== undefined) return reject(`DMARC passed for ${dmarc.domain}, not for ${unaligned}`);
        return Effect.void;
      },
    };
  })
);
