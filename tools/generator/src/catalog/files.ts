import { Buffer } from 'node:buffer';

import { cellText } from '@leads/shared/domain/schemas';
import type { LeadSourceType } from '@leads/shared/domain/types';
import { utils, write } from 'xlsx';

import { generators } from '../sources';
import { generate } from '../workbooks';

export type Cells = readonly unknown[];

/** The cells of fake leads of one source, in the column order of its header. */
export function leadRows(source: LeadSourceType, amount: number): Cells[] {
  const { header, generate: lead } = generators[source];
  return generate(amount, lead).map((row: Record<string, unknown>) => header.map((column) => row[column] ?? ''));
}

export const headerOf = (source: LeadSourceType): string[] => [...generators[source].header];

export type Sheet = { readonly name: string; readonly rows: readonly Cells[]; readonly hidden?: boolean };

/** A workbook as Excel writes it. `bookType` also makes the formats that the pipeline refuses, such as `biff8`. */
export function book(sheets: readonly Sheet[], bookType: 'xlsx' | 'xlsm' | 'xlsb' | 'biff8' | 'ods' = 'xlsx'): Buffer {
  const workbook = utils.book_new();
  for (const sheet of sheets)
    utils.book_append_sheet(workbook, utils.aoa_to_sheet(sheet.rows.map((row) => [...row])), sheet.name);
  if (sheets.some((sheet) => sheet.hidden)) {
    workbook.Workbook = { Sheets: sheets.map((sheet) => ({ Hidden: sheet.hidden ? 1 : 0 })) };
  }
  return Buffer.from(write(workbook, { type: 'buffer', bookType, compression: true }));
}

/** One sheet named `Leads`, with the header of the source in row 1. */
export const leadsBook = (source: LeadSourceType, rows: readonly Cells[]) =>
  book([{ name: 'Leads', rows: [headerOf(source), ...rows] }]);

export const csv = (rows: readonly Cells[]) =>
  Buffer.from(
    rows.map((row) => row.map((cell) => `"${(cellText(cell) ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')
  );

/** A transparent PNG of 1 x 1 pixel, as an email client puts a logo in a signature. */
export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

export const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

export const calendarInvite = Buffer.from(
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'SUMMARY:Leads review',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
);

// ---------- Email ----------

export type Part =
  | {
      readonly filename?: string;
      readonly contentType: string;
      readonly content: Buffer;
      readonly disposition?: 'attachment' | 'inline';
      readonly contentID?: string;
    }
  | { readonly raw: string };

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const xlsxPart = (filename: string, content: Buffer): Part => ({ filename, contentType: XLSX_TYPE, content });

/** A file name that is not ASCII goes in the RFC 2231 form, as mail clients send it. */
const filenameParameter = (filename: string) =>
  /^[\x20-\x7e]*$/.test(filename)
    ? `; filename="${filename.replace(/"/g, '\\"')}"`
    : `; filename*=UTF-8''${encodeURIComponent(filename)}`;

/** Base64 in lines of 76 characters, as RFC 2045 asks. One string, because a large file has too many lines to spread. */
const base64Lines = (content: Buffer) => content.toString('base64').replace(/.{76}/g, '$&\r\n').replace(/\r\n$/, '');

/** `dmarc` is the verdict that the header reports. `domain` is its `header.from`. */
export type AuthenticationResults = { readonly authservID?: string; readonly dmarc?: string; readonly domain: string };

/** The `Authentication-Results` header that SES adds above the headers of the sender, folded as SES writes it. */
export function authenticationResults({ authservID = 'amazonses.com', dmarc, domain }: AuthenticationResults): string {
  return [
    `Authentication-Results: ${authservID};`,
    ` spf=pass (spfCheck: domain of ${domain} designates 192.0.2.1 as permitted sender) client-ip=192.0.2.1; envelope-from=sender@${domain};`,
    ` dkim=pass header.i=@${domain};`,
    ...(dmarc === undefined ? [] : [` dmarc=${dmarc} header.from=${domain};`]),
  ].join('\r\n');
}

/** A raw email as SES stores it in the inbox bucket. `headers` come first, so put the SES header first. */
export function email(headers: readonly string[], parts: readonly Part[], recipient: string): Buffer {
  const boundary = 'leads-catalog-boundary';
  const lines = [
    ...headers,
    `To: ${recipient}`,
    'Subject: Lead sources',
    'Date: Sun, 11 Oct 2026 12:00:00 +0000',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please process the attached lead sources.',
  ];
  for (const part of parts) {
    lines.push(`--${boundary}`);
    if ('raw' in part) {
      lines.push(part.raw);
      continue;
    }
    lines.push(
      `Content-Type: ${part.contentType}`,
      `Content-Disposition: ${part.disposition ?? 'attachment'}${part.filename === undefined ? '' : filenameParameter(part.filename)}`,
      ...(part.contentID === undefined ? [] : [`Content-ID: <${part.contentID}>`]),
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(part.content)
    );
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'));
}

// ---------- S3 notifications ----------

export type NotificationRecord = { readonly bucket?: string; readonly key: string; readonly eventTime?: string };

/** The S3 notification that the bucket sends to its queue, with the key URL-encoded as S3 sends it. */
export function s3Notification(records: readonly NotificationRecord[], region: string) {
  return {
    Records: records.map(({ bucket, key, eventTime }) => ({
      eventVersion: '2.1',
      eventSource: 'aws:s3',
      awsRegion: region,
      ...(eventTime === undefined ? {} : { eventTime }),
      eventName: 'ObjectCreated:Put',
      s3: {
        s3SchemaVersion: '1.0',
        bucket: bucket === undefined ? {} : { name: bucket, arn: `arn:aws:s3:::${bucket}` },
        object: { key: encodeURIComponent(key).replace(/%2F/g, '/').replace(/%20/g, '+'), size: 1 },
      },
    })),
  };
}

export const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
