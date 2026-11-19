import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

export type Attachment = { readonly filename: string; readonly content: Buffer };

export type EmailOptions = {
  /** `false` leaves out the `Authentication-Results` header of SES, as for an email that SES did not authenticate. */
  readonly authenticated?: boolean;
  /** Raw header lines between the SES headers and From, such as a second From header. */
  readonly headers?: readonly string[];
};

/** The address in `Name <address>`, or the whole value. */
const addressOf = (from: string) => /<([^>]*)>/.exec(from)?.[1] ?? from;

/** The header that SES adds above the headers of the sender when DMARC passes for the From domain. */
export function sesAuthenticationResults(from: string): string {
  const domain = addressOf(from).split('@').pop()!.trim().toLowerCase();
  return [
    'Authentication-Results: amazonses.com;',
    ` spf=pass (spfCheck: domain of ${domain} designates 192.0.2.1 as permitted sender) client-ip=192.0.2.1;`,
    ` dkim=pass header.i=@${domain};`,
    ` dmarc=pass header.from=${domain};`,
  ].join('\r\n');
}

/** An email as SES stores it in the inbox bucket. By default SES reports a DMARC pass for the From domain. */
export function email(from: string, attachments: readonly Attachment[] = [], options: EmailOptions = {}): Buffer {
  const boundary = `leads-integration-${randomUUID()}`;
  const lines = [
    ...(options.authenticated === false ? [] : [sesAuthenticationResults(from)]),
    ...(options.headers ?? []),
    `From: ${from}`,
    'To: leads@example.ch',
    'Subject: Swiss lead sources',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please process the attached lead source files.',
  ];
  for (const attachment of attachments) {
    lines.push(
      `--${boundary}`,
      'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      attachment.content.toString('base64')
    );
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'));
}
