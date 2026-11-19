import { describe, expect, test } from 'vitest';

import { toDmarc, toEmailAuthentication } from '#Core/Pipeline/Domain/Transformations/emailAuthentication';

const ses = (results: string) => `Authentication-Results: amazonses.com; ${results}`;

/** The header that SES adds to an email from example.com, folded as SES writes it. */
const sesPass = [
  'Authentication-Results: amazonses.com;',
  ' spf=pass (spfCheck: domain of example.com designates 209.85.128.41 as permitted sender) client-ip=209.85.128.41; envelope-from=owner@example.com; helo=mail-wm1-f41.google.com;',
  ' dkim=pass header.i=@example.com;',
  ' dmarc=pass header.from=example.com;',
].join('\r\n');

const from = 'From: Owner <owner@example.com>';

describe('toEmailAuthentication', () => {
  test('reads the DMARC pass that SES reported and counts one From header', () => {
    expect(toEmailAuthentication([sesPass, from, 'To: leads@example.com'])).toEqual({
      fromHeaders: 1,
      dmarc: { verdict: 'pass', domain: 'example.com' },
    });
  });

  test.each(['fail', 'none', 'temperror', 'permerror'] as const)('reads a DMARC %s', (verdict) => {
    expect(toEmailAuthentication([ses(`dmarc=${verdict} header.from=example.com;`), from]).dmarc).toEqual({
      verdict,
      domain: 'example.com',
    });
  });

  test('has no DMARC result without an Authentication-Results header', () => {
    expect(toEmailAuthentication([from, 'To: leads@example.com'])).toEqual({ fromHeaders: 1, dmarc: undefined });
  });

  test('trusts only the topmost header, so a forged pass below a SES fail does not count', () => {
    const forged = ses('dmarc=pass header.from=example.com;');

    expect(toEmailAuthentication([ses('dmarc=fail header.from=example.com;'), from, forged]).dmarc).toEqual({
      verdict: 'fail',
      domain: 'example.com',
    });
    expect(toEmailAuthentication([sesPass, forged.replace('pass', 'fail'), from]).dmarc).toEqual({
      verdict: 'pass',
      domain: 'example.com',
    });
  });

  test('has no DMARC result when the topmost header comes from another server', () => {
    const foreign = 'Authentication-Results: mx.google.com; dmarc=pass header.from=example.com';

    expect(toEmailAuthentication([foreign, sesPass, from]).dmarc).toBeUndefined();
  });

  test('counts every From header in any case', () => {
    expect(toEmailAuthentication([sesPass, 'From: a@example.org', 'from: ' + from.slice(6)]).fromHeaders).toBe(2);
    expect(toEmailAuthentication([sesPass, 'FROM : a@example.org', from]).fromHeaders).toBe(2);
  });

  test('does not count headers that only start with From', () => {
    expect(toEmailAuthentication([sesPass, 'From-Name: Owner', 'X-Original-From: a@example.org']).fromHeaders).toBe(0);
  });

  test('reads a header name in any case', () => {
    expect(
      toEmailAuthentication(['authentication-RESULTS: AmazonSES.com; DMARC=Pass header.from=Example.COM']).dmarc
    ).toEqual({
      verdict: 'pass',
      domain: 'example.com',
    });
  });

  test('has no From header and no DMARC result for a file that is not an email', () => {
    expect(toEmailAuthentication(['Lorem ipsum dolor sit amet.'])).toEqual({ fromHeaders: 0, dmarc: undefined });
    expect(toEmailAuthentication([])).toEqual({ fromHeaders: 0, dmarc: undefined });
  });
});

describe('toDmarc', () => {
  test.each([
    ['extra whitespace', '  amazonses.com ;   dmarc  =  pass   header.from =  example.com ; '],
    [
      'folded lines',
      ' amazonses.com;\r\n\tspf=pass smtp.mailfrom=example.com;\r\n dmarc=pass\r\n  header.from=example.com;',
    ],
    ['a version after the authserv-id', ' amazonses.com 1; dmarc=pass header.from=example.com'],
    ['comments', ' amazonses.com (SES (inbound)); dmarc=pass (p=NONE; sp=QUARANTINE) header.from=example.com;'],
    ['an address in header.from, as the SES docs show', ' amazonses.com; dmarc=pass header.from=someone@example.com;'],
    ['a quoted header.from', ' amazonses.com; dmarc=pass header.from="example.com";'],
    [
      'dmarc after other methods',
      ' amazonses.com; spf=fail smtp.mailfrom=x.org; dkim=none; dmarc=pass header.from=example.com',
    ],
  ])('reads a DMARC pass with %s', (_, value) => {
    expect(toDmarc(value)).toEqual({ verdict: 'pass', domain: 'example.com' });
  });

  test('ignores a header.from inside a comment', () => {
    expect(toDmarc(' amazonses.com; dmarc=pass (header.from=evil.org) header.from=example.com')).toEqual({
      verdict: 'pass',
      domain: 'example.com',
    });
  });

  test.each([
    ['another authserv-id', ' mx.google.com; dmarc=pass header.from=example.com'],
    ['a lookalike authserv-id', ' amazonses.com.evil.org; dmarc=pass header.from=example.com'],
    ['the authserv-id inside a comment', ' (amazonses.com) evil.org; dmarc=pass header.from=example.com'],
    ['no results', ' amazonses.com; none'],
    ['no dmarc result', ' amazonses.com; spf=pass smtp.mailfrom=example.com; dkim=pass header.i=@example.com'],
    ['a dmarc result without header.from', ' amazonses.com; dmarc=pass'],
    ['an unknown dmarc result', ' amazonses.com; dmarc=softpass header.from=example.com'],
    ['an empty header.from', ' amazonses.com; dmarc=pass header.from=""'],
    ['an empty value', ''],
  ])('has no DMARC result for %s', (_, value) => {
    expect(toDmarc(value)).toBeUndefined();
  });
});
