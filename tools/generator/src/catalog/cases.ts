import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import { LeadFromRow_BusinessClosure } from '@leads/shared/domain/sources/BusinessClosure';
import { Schema } from 'effect';

import { faker } from '../faker';
import { generators } from '../sources';
import {
  authenticationResults,
  book,
  calendarInvite,
  type Cells,
  csv,
  email,
  headerOf,
  json,
  leadRows,
  leadsBook,
  type Part,
  pdf,
  png,
  s3Notification,
  xlsxPart,
} from './files';

export type Context = {
  /** The number of leads in a valid workbook. */
  readonly rows: number;
  /** The whitelisted sender. */
  readonly owner: string;
  /** The address that SES receives into the inbox bucket. */
  readonly recipient: string;
  readonly region: string;
  readonly buckets: { readonly inbox: string; readonly leadSources: string };
};

/** Where a file goes to start the pipeline. Each one has its own folder. */
export type Destination =
  | 'email-attachment'
  | 'inbox-bucket'
  | 'lead-sources-bucket'
  | 'leads-queue'
  | 'inbox-queue'
  | 'lead-sources-queue';

/** What the parsers and the guard must do with the file. The catalog test checks it with the real adapters. */
export type Check =
  | { readonly kind: 'workbook'; readonly leads: number; readonly rejected?: number; readonly uniqueKeys?: number }
  | {
      readonly kind: 'workbook';
      readonly error: 'File is empty' | 'NotAnExcelDocument' | 'ExcelSheetNotParsed' | 'UnknownLeadsSource';
    }
  | { readonly kind: 'email'; readonly authorized: true; readonly attachments: readonly string[] }
  | { readonly kind: 'email'; readonly rejected: string }
  | { readonly kind: 'email'; readonly error: 'EmailNotParsed' }
  | { readonly kind: 'lead'; readonly accepted: boolean }
  | { readonly kind: 'notification'; readonly records: number }
  | { readonly kind: 'notification'; readonly throws: true };

type Text = string | ((context: Context) => string);

export type Case = {
  /** The ID of the case in the input catalog, such as `A5-06`. The file name starts with it. */
  readonly id: string;
  readonly slug: string;
  readonly extension: string;
  readonly destination: Destination;
  readonly title: string;
  readonly expected: Text;
  readonly note?: Text;
  /** A large file, made only without `--skip-large`. The catalog test does not parse it. */
  readonly large?: boolean;
  /** The S3 key, when it is not the file name. */
  readonly key?: (file: string) => string;
  readonly build: (context: Context) => Buffer;
  readonly check?: Check | ((context: Context) => Check);
};

export const fileName = (item: Case) => `${item.id}--${item.slug}.${item.extension}`;

// ---------- Shared parts ----------

const valid = (context: Context) => leadsBook('business_closure', leadRows('business_closure', context.rows));
const ok = (context: Context) => `OK(${context.rows})`;
const domainOf = (address: string) => address.split('@').pop()!;

/** An email from the whitelisted sender, with the header that SES writes when DMARC passes, and one valid workbook. */
const ownerEmail = (
  context: Context,
  { headers, parts }: { readonly headers?: readonly string[]; readonly parts?: readonly Part[] } = {}
) =>
  email(
    headers ?? [authenticationResults({ dmarc: 'pass', domain: domainOf(context.owner) }), `From: ${context.owner}`],
    parts ?? [xlsxPart('leads.xlsx', valid(context))],
    context.recipient
  );

const authorized = (...attachments: string[]): Check => ({ kind: 'email', authorized: true, attachments });
const rejected = (reason: string): Check => ({ kind: 'email', rejected: reason });

// ---------- A2: sender and authentication ----------

type SenderCase = {
  readonly slug: string;
  readonly title: string;
  readonly headers: (context: Context, gmail: string) => string[];
  readonly reason?: string;
  readonly expected?: string;
};

const pass = (domain: string) => authenticationResults({ dmarc: 'pass', domain });

const senderCases: readonly SenderCase[] = [
  {
    slug: 'owner-dmarc-pass',
    title: 'The whitelisted sender, and SES reports a DMARC pass',
    headers: (c, d) => [pass(d), `From: ${c.owner}`],
  },
  {
    slug: 'owner-display-name-upper-case',
    title: 'The whitelisted sender with a display name, in upper case',
    headers: (c, d) => [pass(d), `From: "Owner" <${c.owner.toUpperCase()}>`],
  },
  {
    slug: 'owner-from-stranger-sender',
    title: 'From is the whitelisted sender, and Sender is a stranger',
    headers: (c, d) => [pass(d), `From: ${c.owner}`, 'Sender: someone@example.com'],
  },
  {
    slug: 'forged-from-dmarc-fail',
    title: 'A forged From: SES reports dmarc=fail',
    headers: (c, d) => [authenticationResults({ dmarc: 'fail', domain: d }), `From: ${c.owner}`],
    reason: 'DMARC did not pass for {domain}',
  },
  {
    slug: 'dmarc-none',
    title: 'SES reports dmarc=none',
    headers: (c, d) => [authenticationResults({ dmarc: 'none', domain: d }), `From: ${c.owner}`],
    reason: 'DMARC did not pass for {domain}',
  },
  {
    slug: 'dmarc-temperror',
    title: 'SES reports dmarc=temperror',
    headers: (c, d) => [authenticationResults({ dmarc: 'temperror', domain: d }), `From: ${c.owner}`],
    reason: 'DMARC did not pass for {domain}',
  },
  {
    slug: 'dmarc-permerror',
    title: 'SES reports dmarc=permerror',
    headers: (c, d) => [authenticationResults({ dmarc: 'permerror', domain: d }), `From: ${c.owner}`],
    reason: 'DMARC did not pass for {domain}',
  },
  {
    slug: 'dmarc-unknown-verdict',
    title: 'SES reports a DMARC verdict that the parser does not know',
    headers: (c, d) => [authenticationResults({ dmarc: 'bestguesspass', domain: d }), `From: ${c.owner}`],
    reason: 'Email is not authenticated by SES',
  },
  {
    slug: 'dmarc-result-missing',
    title: 'The SES header has no dmarc result',
    headers: (c, d) => [authenticationResults({ domain: d }), `From: ${c.owner}`],
    reason: 'Email is not authenticated by SES',
  },
  {
    slug: 'dmarc-pass-other-domain',
    title: 'DMARC passed, but for a different domain than the sender domain',
    headers: (c) => [pass('evil.example'), `From: ${c.owner}`],
    reason: 'DMARC passed for evil.example, not for {domain}',
  },
  {
    slug: 'forged-pass-below-ses-fail',
    title: 'A forged dmarc=pass header below the SES header that reports dmarc=fail',
    headers: (c, d) => [authenticationResults({ dmarc: 'fail', domain: d }), pass(d), `From: ${c.owner}`],
    reason: 'DMARC did not pass for {domain}',
  },
  {
    slug: 'two-from-headers',
    title: 'Two From headers: a stranger first, then the whitelisted sender',
    headers: (c, d) => [pass(d), 'From: someone@example.com', `From: ${c.owner}`],
    reason: 'Email has more than one From header',
  },
  {
    slug: 'from-owner-and-stranger',
    title: 'One From header with the whitelisted sender and a stranger',
    headers: (c, d) => [pass(d), `From: ${c.owner}, someone@example.com`],
    reason: 'Sender is outside the whitelist',
  },
  {
    slug: 'from-stranger-reply-to-owner',
    title: 'From is a stranger, and Reply-To is the whitelisted sender',
    headers: (c) => [pass('example.com'), 'From: someone@example.com', `Reply-To: ${c.owner}`],
    reason: 'Sender is outside the whitelist',
  },
  {
    slug: 'googlemail-alias',
    title: 'The googlemail.com form of the whitelisted Gmail address',
    headers: (c) => [pass('googlemail.com'), `From: ${c.owner.split('@')[0]}@googlemail.com`],
    reason: 'Sender is outside the whitelist',
  },
  { slug: 'no-from', title: 'No From header', headers: (_, d) => [pass(d)], reason: 'Email has no sender' },
  {
    slug: 'from-group-syntax',
    title: 'From is an empty group: undisclosed-recipients:;',
    headers: (_, d) => [pass(d), 'From: undisclosed-recipients:;'],
    reason: 'Email has no sender',
  },
  {
    slug: 'no-authentication-results',
    title: 'No Authentication-Results header',
    headers: (c) => [`From: ${c.owner}`],
    reason: 'Email is not authenticated by SES',
  },
  {
    slug: 'foreign-authserv-id',
    title: 'The top Authentication-Results header is from mx.google.com, not from SES',
    headers: (c, d) => [
      authenticationResults({ authservID: 'mx.google.com', dmarc: 'pass', domain: d }),
      `From: ${c.owner}`,
    ],
    reason: 'Email is not authenticated by SES',
  },
];

const a2: Case[] = senderCases.map((item, index) => {
  const reason = (context: Context) => item.reason?.replace('{domain}', domainOf(context.owner));
  return {
    id: `A2-${String(index + 1).padStart(2, '0')}`,
    slug: item.slug,
    extension: 'eml',
    destination: 'inbox-bucket',
    title: item.title,
    expected: (context) => (item.reason === undefined ? ok(context) : `REJECTED: \`${reason(context)}\``),
    build: (context) => ownerEmail(context, { headers: item.headers(context, domainOf(context.owner)) }),
    check: (context) => (item.reason === undefined ? authorized('01-leads') : rejected(reason(context)!)),
  };
});

// ---------- A3: attachments ----------

const forwardedEmail = Buffer.from(
  [
    'From: someone@example.com',
    'Subject: Fwd: leads',
    'Content-Type: text/plain',
    '',
    'See the earlier email.',
    '',
  ].join('\r\n')
);

const a3Files: Case[] = [
  {
    id: 'A3-01',
    slug: 'signature-logo',
    extension: 'png',
    destination: 'email-attachment',
    title: 'An image in the signature or the body',
    note: 'Paste the image into the body, so that Gmail sends it inline. Attach a valid workbook too.',
    expected: 'SRC-DELETED for the image (`NotAnExcelDocument`). The workbook continues.',
    build: () => png,
    check: { kind: 'workbook', error: 'NotAnExcelDocument' },
  },
  {
    id: 'A3-02',
    slug: 'forwarded',
    extension: 'eml',
    destination: 'email-attachment',
    title: 'A forwarded email as an attachment',
    expected: 'SRC-DELETED for the .eml (`NotAnExcelDocument`)',
    build: () => forwardedEmail,
    check: { kind: 'workbook', error: 'NotAnExcelDocument' },
  },
  {
    id: 'A3-03',
    slug: 'calendar-invite',
    extension: 'ics',
    destination: 'email-attachment',
    title: 'A calendar invite',
    expected: 'SRC-DELETED for the invite (`NotAnExcelDocument`)',
    build: () => calendarInvite,
    check: { kind: 'workbook', error: 'NotAnExcelDocument' },
  },
  {
    id: 'A3-04',
    slug: 'empty',
    extension: 'xlsx',
    destination: 'email-attachment',
    title: 'A 0-byte attachment',
    note: 'Gmail can refuse an empty file. Then use the .eml form in 2-inbox-bucket.',
    expected: 'SRC-DELETED (`File is empty`)',
    build: () => Buffer.alloc(0),
    check: { kind: 'workbook', error: 'File is empty' },
  },
];

const a3Emails: Case[] = [
  {
    id: 'A3-01',
    slug: 'inline-image-and-workbook',
    extension: 'eml',
    destination: 'inbox-bucket',
    title: 'An inline signature image and a valid workbook',
    expected: (c) => `${ok(c)}. SRC-DELETED for \`01-logo\`.`,
    build: (c) =>
      ownerEmail(c, {
        parts: [
          { filename: 'logo.png', contentType: 'image/png', content: png, disposition: 'inline', contentID: 'logo' },
          xlsxPart('leads.xlsx', valid(c)),
        ],
      }),
    check: authorized('01-logo', '02-leads'),
  },
  {
    id: 'A3-02',
    slug: 'forwarded-email-and-workbook',
    extension: 'eml',
    destination: 'inbox-bucket',
    title: 'A forwarded email (message/rfc822) and a valid workbook',
    expected: (c) => `${ok(c)}. SRC-DELETED for \`01-forwarded\`.`,
    build: (c) =>
      ownerEmail(c, {
        parts: [
          {
            raw: [
              'Content-Type: message/rfc822',
              'Content-Disposition: attachment; filename="forwarded.eml"',
              '',
              forwardedEmail.toString(),
            ].join('\r\n'),
          },
          xlsxPart('leads.xlsx', valid(c)),
        ],
      }),
    check: authorized('01-forwarded', '02-leads'),
  },
  {
    id: 'A3-03',
    slug: 'calendar-invite-and-workbook',
    extension: 'eml',
    destination: 'inbox-bucket',
    title: 'A calendar invite and a valid workbook',
    expected: (c) => `${ok(c)}. SRC-DELETED for \`01-attachment\`.`,
    build: (c) =>
      ownerEmail(c, {
        parts: [
          { raw: ['Content-Type: text/calendar; method=REQUEST', '', calendarInvite.toString()].join('\r\n') },
          xlsxPart('leads.xlsx', valid(c)),
        ],
      }),
    check: authorized('01-attachment', '02-leads'),
  },
  {
    id: 'A3-04',
    slug: 'empty-attachment-and-workbook',
    extension: 'eml',
    destination: 'inbox-bucket',
    title: 'A 0-byte attachment and a valid workbook',
    expected: (c) => `${ok(c)}. SRC-DELETED for \`01-empty\` (\`File is empty\`).`,
    build: (c) => ownerEmail(c, { parts: [xlsxPart('empty.xlsx', Buffer.alloc(0)), xlsxPart('leads.xlsx', valid(c))] }),
    check: authorized('01-empty', '02-leads'),
  },
  {
    id: 'A3-05',
    slug: 'file-names',
    extension: 'eml',
    destination: 'inbox-bucket',
    title: 'Seven copies of one workbook with difficult file names',
    expected: (c) => `7 sources, but ${ok(c)}: the rows are the same, so the orders are made only one time.`,
    build: (c) => {
      const workbook = valid(c);
      const names = [
        'Report.xlsx',
        'Report.xlsx',
        undefined,
        'Лиды март.xlsx',
        '../../etc/passwd.xlsx',
        'Übersicht Q3 (final).v2.xlsx',
        '.xlsx',
      ];
      return ownerEmail(c, {
        parts: names.map((filename) =>
          filename === undefined
            ? { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: workbook }
            : xlsxPart(filename, workbook)
        ),
      });
    },
    check: authorized(
      '01-report',
      '02-report',
      '03-attachment',
      '04-lidy-mart',
      '05-attachment',
      '06-ubersicht-q-3-final',
      '07-attachment'
    ),
  },
  {
    id: 'A3-06',
    slug: 'no-attachment',
    extension: 'eml',
    destination: 'inbox-bucket',
    title: 'No attachment',
    expected: 'NO-SOURCES',
    build: (c) => ownerEmail(c, { parts: [] }),
    check: authorized(),
  },
  {
    id: 'A3-07',
    slug: 'three-source-types',
    extension: 'eml',
    destination: 'inbox-bucket',
    title: 'One valid workbook of each source type',
    expected: (c) => `OK(${3 * c.rows})`,
    build: (c) =>
      ownerEmail(c, {
        parts: (['business_closure', 'new_acquisition', 'mutation'] as const).map((source) =>
          xlsxPart(`${source}.xlsx`, leadsBook(source, leadRows(source, c.rows)))
        ),
      }),
    check: authorized('01-business-closure', '02-new-acquisition', '03-mutation'),
  },
  {
    id: 'A3-08',
    slug: 'workbook-named-pdf',
    extension: 'eml',
    destination: 'inbox-bucket',
    title: 'A valid workbook with the name `leads.pdf`',
    expected: ok,
    build: (c) =>
      ownerEmail(c, { parts: [{ filename: 'leads.pdf', contentType: 'application/pdf', content: valid(c) }] }),
    check: authorized('01-leads'),
  },
];

// ---------- A4: workbook file format ----------

const formatCase = (
  number: string,
  slug: string,
  extension: string,
  title: string,
  build: (c: Context) => Buffer,
  check: Check | ((c: Context) => Check),
  expected: Text
): Case => ({ id: `A4-${number}`, slug, extension, destination: 'email-attachment', title, build, check, expected });

const deleted = (error: string) => `SRC-DELETED (\`${error}\`)`;
const validRows = (c: Context) => [headerOf('business_closure'), ...leadRows('business_closure', c.rows)];

const a4: Case[] = [
  formatCase(
    '01',
    'macro-enabled',
    'xlsm',
    'A macro-enabled workbook',
    (c) => book([{ name: 'Leads', rows: validRows(c) }], 'xlsm'),
    (c) => ({ kind: 'workbook', leads: c.rows }),
    ok
  ),
  formatCase(
    '02',
    'binary',
    'xlsb',
    'A binary workbook',
    (c) => book([{ name: 'Leads', rows: validRows(c) }], 'xlsb'),
    { kind: 'workbook', error: 'NotAnExcelDocument' },
    deleted('NotAnExcelDocument')
  ),
  formatCase(
    '03',
    'excel-97',
    'xls',
    'An Excel 97–2003 workbook',
    (c) => book([{ name: 'Leads', rows: validRows(c) }], 'biff8'),
    { kind: 'workbook', error: 'NotAnExcelDocument' },
    deleted('NotAnExcelDocument')
  ),
  formatCase(
    '04',
    'opendocument',
    'ods',
    'An OpenDocument spreadsheet',
    (c) => book([{ name: 'Leads', rows: validRows(c) }], 'ods'),
    { kind: 'workbook', error: 'NotAnExcelDocument' },
    deleted('NotAnExcelDocument')
  ),
  formatCase(
    '05',
    'comma-separated',
    'csv',
    'The same rows as CSV',
    (c) => csv(validRows(c)),
    { kind: 'workbook', error: 'NotAnExcelDocument' },
    deleted('NotAnExcelDocument')
  ),
  formatCase(
    '06',
    'pdf',
    'pdf',
    'A PDF',
    () => pdf,
    { kind: 'workbook', error: 'NotAnExcelDocument' },
    deleted('NotAnExcelDocument')
  ),
  formatCase(
    '07',
    'png',
    'png',
    'A PNG image',
    () => png,
    { kind: 'workbook', error: 'NotAnExcelDocument' },
    deleted('NotAnExcelDocument')
  ),
  formatCase(
    '08',
    'damaged',
    'xlsx',
    'A valid workbook cut to 60 % of its length',
    (c) => {
      const workbook = valid(c);
      return workbook.subarray(0, Math.floor(workbook.length * 0.6));
    },
    { kind: 'workbook', error: 'ExcelSheetNotParsed' },
    deleted('ExcelSheetNotParsed')
  ),
  formatCase(
    '09',
    'empty',
    'xlsx',
    'A 0-byte workbook',
    () => Buffer.alloc(0),
    { kind: 'workbook', error: 'File is empty' },
    deleted('File is empty')
  ),
  formatCase(
    '10',
    'valid-named-pdf',
    'pdf',
    'A valid workbook with the extension .pdf',
    valid,
    (c) => ({ kind: 'workbook', leads: c.rows }),
    (c) => `${ok(c)}. The type comes from the bytes, not from the name.`
  ),
];

// ---------- A5: sheet and header ----------

const header = headerOf('business_closure');

const sheetCase = (
  number: string,
  slug: string,
  title: string,
  sheets: (c: Context, rows: Cells[]) => Parameters<typeof book>[0],
  check: Check | ((c: Context) => Check),
  expected: Text
): Case => ({
  id: `A5-${number}`,
  slug,
  extension: 'xlsx',
  destination: 'email-attachment',
  title,
  build: (c) => book(sheets(c, leadRows('business_closure', c.rows))),
  check,
  expected,
});

const leadsCheck = (c: Context): Check => ({ kind: 'workbook', leads: c.rows });
const unknown: Check = { kind: 'workbook', error: 'UnknownLeadsSource' };
const notParsed: Check = { kind: 'workbook', error: 'ExcelSheetNotParsed' };

const a5: Case[] = [
  ...(['business_closure', 'new_acquisition', 'mutation'] as const).map((source, index): Case => ({
    id: `A5-0${index + 1}`,
    slug: `valid-${source.replace(/_/g, '-')}`,
    extension: 'xlsx',
    destination: 'email-attachment',
    title: `A valid ${source} workbook`,
    build: (c) => leadsBook(source, leadRows(source, c.rows)),
    check: leadsCheck,
    expected: ok,
  })),
  sheetCase(
    '04',
    'extra-column',
    'An extra column at the end of the header',
    (_, rows) => [{ name: 'Leads', rows: [[...header, 'Extra'], ...rows.map((row) => [...row, 'x'])] }],
    unknown,
    deleted('UnknownLeadsSource')
  ),
  sheetCase(
    '05',
    'missing-column',
    'The last column is missing',
    (_, rows) => [{ name: 'Leads', rows: [header.slice(0, -1), ...rows.map((row) => row.slice(0, -1))] }],
    unknown,
    deleted('UnknownLeadsSource')
  ),
  sheetCase(
    '06',
    'columns-reordered',
    'The first two columns change places',
    (_, rows) => [
      {
        name: 'Leads',
        rows: [[header[1], header[0], ...header.slice(2)], ...rows.map(([a, b, ...rest]) => [b, a, ...rest])],
      },
    ],
    unknown,
    deleted('UnknownLeadsSource')
  ),
  sheetCase(
    '07',
    'header-trailing-space',
    'A space after the first header name',
    (_, rows) => [{ name: 'Leads', rows: [[`${header[0]} `, ...header.slice(1)], ...rows] }],
    unknown,
    deleted('UnknownLeadsSource')
  ),
  sheetCase(
    '08',
    'header-lower-case',
    'The header in lower case',
    (_, rows) => [{ name: 'Leads', rows: [header.map((name) => name.toLowerCase()), ...rows] }],
    unknown,
    deleted('UnknownLeadsSource')
  ),
  sheetCase(
    '09',
    'header-blank-cell',
    'A blank cell in the header',
    (_, rows) => [{ name: 'Leads', rows: [[header[0], null, ...header.slice(2)], ...rows] }],
    notParsed,
    deleted('ExcelSheetNotParsed')
  ),
  sheetCase(
    '10',
    'header-numeric-cell',
    'A number in the header',
    (_, rows) => [{ name: 'Leads', rows: [[2026, ...header.slice(1)], ...rows] }],
    notParsed,
    deleted('ExcelSheetNotParsed')
  ),
  sheetCase(
    '11',
    'header-starts-at-b1',
    'The header starts at B1, and column A is empty',
    (_, rows) => [{ name: 'Leads', rows: [header, ...rows].map((row) => [null, ...row]) }],
    notParsed,
    deleted('ExcelSheetNotParsed')
  ),
  sheetCase(
    '12',
    'title-row-above-header',
    'A title row above the header',
    (_, rows) => [{ name: 'Leads', rows: [['Leads export Q3'], header, ...rows] }],
    unknown,
    deleted('UnknownLeadsSource')
  ),
  sheetCase(
    '13',
    'leads-on-sheet-2-empty-sheet-1',
    'The leads are on sheet 2, and sheet 1 is empty',
    (_, rows) => [
      { name: 'Cover', rows: [] },
      { name: 'Leads', rows: [header, ...rows] },
    ],
    unknown,
    deleted('UnknownLeadsSource')
  ),
  sheetCase(
    '14',
    'leads-on-sheet-2-note-on-sheet-1',
    'The leads are on sheet 2, and sheet 1 has a note',
    (_, rows) => [
      { name: 'Cover', rows: [['See the next sheet']] },
      { name: 'Leads', rows: [header, ...rows] },
    ],
    unknown,
    deleted('UnknownLeadsSource')
  ),
  sheetCase(
    '15',
    'leads-on-hidden-sheet-1',
    'The leads are on a hidden sheet 1',
    (_, rows) => [
      { name: 'Leads', rows: [header, ...rows], hidden: true },
      { name: 'Empty', rows: [['nothing']] },
    ],
    leadsCheck,
    (c) => `${ok(c)}. The first sheet in the file counts, also when it is hidden.`
  ),
  sheetCase(
    '16',
    'empty-sheet',
    'A fully empty sheet',
    () => [{ name: 'Leads', rows: [] }],
    unknown,
    deleted('UnknownLeadsSource')
  ),
  sheetCase(
    '17',
    'header-only',
    'The header with no rows',
    () => [{ name: 'Leads', rows: [header] }],
    { kind: 'workbook', leads: 0 },
    deleted('NoValidLeadsExtracted')
  ),
];

// ---------- A6: rows and cells ----------

const emptyish = (value: string) => header.map(() => value);
const objectRow = (row: Cells) => Object.fromEntries(header.map((column, index) => [column, row[index]]));
const toCells = (row: Record<string, unknown>) => header.map((column) => row[column] ?? '');
const long = (length: number) => faker.string.alpha(length);

const rowCase = (
  number: string,
  slug: string,
  title: string,
  rows: (c: Context, generated: (amount: number) => Cells[]) => Cells[],
  check: Check | ((c: Context) => Check),
  expected: Text,
  options: { readonly large?: boolean; readonly note?: Text; readonly destination?: Destination } = {}
): Case => ({
  id: `A6-${number}`,
  slug,
  extension: 'xlsx',
  destination: options.destination ?? 'email-attachment',
  title,
  build: (c) =>
    leadsBook(
      'business_closure',
      rows(c, (amount) => leadRows('business_closure', amount))
    ),
  check,
  expected,
  ...(options.large === undefined ? {} : { large: options.large }),
  ...(options.note === undefined ? {} : { note: options.note }),
});

const a6: Case[] = [
  rowCase(
    '01',
    'one-empty-row',
    'One valid row and one row of `K.A.`',
    (_, rows) => [...rows(1), emptyish('K.A.')],
    { kind: 'workbook', leads: 1, rejected: 1 },
    'OK(1), and a warning for row 1 (`Row is empty`)'
  ),
  rowCase(
    '02',
    'only-empty-rows',
    'Only rows of `K.A.`, `.`, and spaces',
    () => [emptyish('K.A.'), emptyish('.'), emptyish('   ')],
    { kind: 'workbook', leads: 0, rejected: 3 },
    deleted('NoValidLeadsExtracted')
  ),
  rowCase(
    '03',
    'blank-rows-between',
    'Blank rows between the data rows',
    (_, rows) => {
      const [first, second] = rows(2);
      return [first!, [], [], second!];
    },
    { kind: 'workbook', leads: 2 },
    'OK(2), with no warning'
  ),
  rowCase(
    '04',
    'value-beyond-header',
    'A value in the column to the right of the header',
    (_, rows) => [[...rows(1)[0]!, 'stray']],
    { kind: 'workbook', leads: 1 },
    'OK(1). The value is dropped, but it changes the idempotency key.'
  ),
  rowCase(
    '05',
    'only-name',
    'Only the `Name` cell has a value',
    () => [toCells({ Name: 'Solo Gastro AG' })],
    { kind: 'workbook', leads: 1 },
    'OK(1). No column is mandatory.'
  ),
  rowCase(
    '06',
    'real-date-cell',
    'A real date cell in `Gültig ab`',
    (_, rows) => [toCells({ ...objectRow(rows(1)[0]!), 'Gültig ab': new Date(Date.UTC(2026, 9, 1)) })],
    { kind: 'workbook', leads: 1 },
    'OK(1), with `Gültig ab` = `2026-10-01`'
  ),
  rowCase(
    '07',
    'eleven-rows',
    'Eleven rows',
    (_, rows) => rows(11),
    { kind: 'workbook', leads: 11 },
    'OK(11), in two SQS batches (10 + 1)'
  ),
  rowCase(
    '08',
    'row-over-400-kb',
    'One row of about 750 KB (15 cells of 30,000 characters)',
    (_, rows) => [
      toCells({
        ...objectRow(rows(1)[0]!),
        ...Object.fromEntries(header.slice(0, 15).map((column) => [column, long(30_000)])),
      }),
    ],
    { kind: 'workbook', leads: 1 },
    'LEADS-DLQ: DynamoDB refuses an item over 400 KB (`OrderStoreFailed`, 1 attempt).',
    {
      large: true,
      note: 'If the leads queue still has the old 256 KiB message limit, SQS refuses the message first: SRC-DLQ.',
    }
  ),
  rowCase(
    '09',
    'batch-over-1-mib',
    '10 rows of about 120 KB each (four cells of 30,000 characters that only `raw` keeps)',
    (_, rows) =>
      rows(10).map((row) =>
        toCells({
          ...objectRow(row),
          TelP: long(30_000),
          TelG: long(30_000),
          MobileP: long(30_000),
          Bemerkung: long(30_000),
        })
      ),
    { kind: 'workbook', leads: 10 },
    'SRC-DLQ: SQS refuses the whole batch of 10 (more than 1 MiB). No order is made, and the workbook stays.',
    { large: true }
  ),
  rowCase(
    '10',
    '100000-rows',
    '100,000 rows (about 36 MiB, too large for an email)',
    (_, rows) => rows(100_000),
    { kind: 'workbook', leads: 100_000 },
    'Risk: OK(100000), or out of memory → SRC-DLQ. The bench workbook of 100,000 rows has 22.8 MiB and peaked at ~1,200 MiB of the 1,536 MB. These rows are larger.',
    { large: true, destination: 'lead-sources-bucket', note: 'This can make 100,000 orders in the table.' }
  ),
  rowCase(
    '11',
    '150000-rows',
    '150,000 rows (about 54 MiB, too large for an email)',
    (_, rows) => rows(150_000),
    { kind: 'workbook', leads: 150_000 },
    'Risk: out of memory or the 5-minute limit → SRC-DLQ after part of the leads is sent. A redrive is safe.',
    { large: true, destination: 'lead-sources-bucket', note: 'This can make up to 150,000 orders in the table.' }
  ),
];

// ---------- A7: duplicates and changes ----------

const a7: Case[] = [
  {
    id: 'A7-01',
    slug: 'identical-rows',
    extension: 'xlsx',
    destination: 'email-attachment',
    title: 'The same row two times in one workbook',
    expected: 'OK(1): 2 lead messages, 1 order',
    build: () => {
      const [row] = leadRows('business_closure', 1);
      return leadsBook('business_closure', [row!, row!]);
    },
    check: { kind: 'workbook', leads: 2, uniqueKeys: 1 },
  },
  {
    id: 'A7-02',
    slug: 'same-row-other-formatting',
    extension: 'xlsx',
    destination: 'email-attachment',
    title: 'The same row with spaces around values, `K.A.` in an empty cell, and the zip code as text',
    expected: 'OK(1): 2 lead messages, 1 order',
    build: () => {
      const row = objectRow(leadRows('business_closure', 1)[0]!);
      const empty = header.find((column) => row[column] === '' || row[column] === undefined) ?? 'AdrZusatz';
      const changed = { ...row, Name: `  ${String(row['Name'])}  `, Plz: String(row['Plz']), [empty]: 'K.A.' };
      return leadsBook('business_closure', [toCells({ ...row, [empty]: '' }), toCells(changed)]);
    },
    check: { kind: 'workbook', leads: 2, uniqueKeys: 1 },
  },
];

/** The same rows, and then one cell changed. Send `a` first and `b` after it. */
const correction = (() => {
  let rows: Cells[] | undefined;
  const original = (c: Context) => (rows ??= leadRows('business_closure', c.rows));
  return [
    {
      id: 'A7-03a',
      slug: 'correction-original',
      extension: 'xlsx',
      destination: 'email-attachment',
      title: 'The original rows. Send this first.',
      expected: ok,
      build: (c) => leadsBook('business_closure', original(c)),
      check: leadsCheck,
    },
    {
      id: 'A7-03b',
      slug: 'correction-changed',
      extension: 'xlsx',
      destination: 'email-attachment',
      title: 'The same rows with one changed cell in the first row. Send this after A7-03a.',
      expected: '1 new order for the changed row. The old order stays, and the other rows make no new order.',
      build: (c) => {
        const [first, ...rest] = original(c);
        return leadsBook('business_closure', [toCells({ ...objectRow(first!), Bemerkung: 'Corrected' }), ...rest]);
      },
      check: leadsCheck,
    },
  ] satisfies Case[];
})();

// ---------- B: object put direct in the inbox bucket ----------

const b: Case[] = [
  {
    id: 'B-01',
    slug: 'empty-object',
    extension: 'eml',
    destination: 'inbox-bucket',
    title: 'A 0-byte object',
    expected: 'REJECTED: `EmailNotParsed` (`File is empty`), and the object is deleted',
    build: () => Buffer.alloc(0),
    check: { kind: 'email', error: 'EmailNotParsed' },
  },
  {
    id: 'B-02',
    slug: 'not-mime',
    extension: 'eml',
    destination: 'inbox-bucket',
    title: 'Plain text that is not an email',
    expected: 'REJECTED: `Email has no sender`, and the object is deleted',
    build: () => Buffer.from('This is not an email.\nIt has no headers.\n'),
    check: rejected('Email has no sender'),
  },
  {
    id: 'B-03',
    slug: 'email-25-mb',
    extension: 'eml',
    destination: 'inbox-bucket',
    title: 'An email of about 25 MB: a valid workbook and 18 MB of random bytes',
    expected: 'Risk: the inbox Lambda has 128 MB of memory → out of memory → INBOX-DLQ',
    large: true,
    build: (c) =>
      ownerEmail(c, {
        parts: [
          xlsxPart('leads.xlsx', valid(c)),
          { filename: 'archive.bin', contentType: 'application/octet-stream', content: randomBytes(18 * 1024 * 1024) },
        ],
      }),
  },
];

// ---------- C: object put direct in the lead-sources bucket ----------

const c: Case[] = [
  {
    id: 'C-01',
    slug: 'valid-at-root',
    extension: 'xlsx',
    destination: 'lead-sources-bucket',
    title: 'A valid workbook at the root of the bucket',
    expected: (context) => `${ok(context)}, with no sender check. The request ID is a hash of the location.`,
    build: valid,
    check: leadsCheck,
  },
  {
    id: 'C-02',
    slug: 'valid-in-request-folder',
    extension: 'xlsx',
    destination: 'lead-sources-bucket',
    title: 'A valid workbook in a folder named with a UUID',
    expected: (context) => `${ok(context)}. The request ID is the UUID of the folder.`,
    key: (file) => `manual/${faker.string.uuid()}/${file}`,
    build: valid,
    check: leadsCheck,
  },
  {
    id: 'C-03',
    slug: 'unknown-header',
    extension: 'xlsx',
    destination: 'lead-sources-bucket',
    title: 'A workbook with an unknown header',
    expected: 'SRC-DELETED (`UnknownLeadsSource`). The file is gone for good: no email keeps a copy.',
    build: (context) =>
      book([
        {
          name: 'Leads',
          rows: [['Firma', 'Ort'], ...leadRows('business_closure', context.rows).map((row) => row.slice(3, 5))],
        },
      ]),
    check: unknown,
  },
];

// ---------- D: message sent direct to the leads queue ----------

const leadOf = (row: Record<string, unknown>) =>
  Schema.decodeSync(LeadFromRow_BusinessClosure)(row) as Record<string, unknown>;

/** One lead for all D cases, so that D-03 has the same idempotency key as D-01. */
const dLead = (() => {
  let lead: Record<string, unknown> | undefined;
  return () => (lead ??= leadOf(generators.business_closure.generate()));
})();

const message = (lead: unknown, extra: Record<string, unknown> = {}) =>
  json({ lead, requestID: 'catalog-d', ...extra });

const leadCase = (
  number: string,
  slug: string,
  title: string,
  build: () => Buffer,
  accepted: boolean,
  expected: string,
  note?: string
): Case => ({
  id: `D-${number}`,
  slug,
  extension: 'json',
  destination: 'leads-queue',
  title,
  build,
  check: { kind: 'lead', accepted },
  expected,
  ...(note === undefined ? {} : { note }),
});

const d: Case[] = [
  leadCase('01', 'valid', 'A valid lead', () => message(dLead()), true, '1 order'),
  leadCase(
    '02',
    'valid-extra-fields',
    'A valid lead with extra fields',
    () =>
      message(
        { ...dLead(), idempotencyKey: `${String(dLead()['idempotencyKey'])}-extra`, unknownField: 1 },
        { note: 'extra' }
      ),
    true,
    '1 order. The extra fields are dropped.'
  ),
  leadCase(
    '03',
    'same-key-as-d-01',
    'The lead of D-01 again, with another request ID',
    () => message(dLead(), { requestID: 'catalog-d-again' }),
    true,
    'No new order (the key is already in the table)',
    'Send it after D-01.'
  ),
  leadCase(
    '04',
    'malformed-json',
    'Text that is not JSON',
    () => Buffer.from('{"lead": nope'),
    false,
    'LEADS-DLQ (`Expected a valid JSON string`)'
  ),
  leadCase('05', 'empty-object', 'An empty JSON object', () => json({}), false, 'LEADS-DLQ (`Missing key`)'),
  leadCase(
    '06',
    'lead-without-wrapper',
    'The lead without the `{ "lead": … }` wrapper',
    () => json(dLead()),
    false,
    'LEADS-DLQ (`Missing key`)'
  ),
  leadCase(
    '07',
    'unknown-source-type',
    'An unknown `extraction_source`',
    () => message({ ...dLead(), extraction_source: 'cold_call' }),
    false,
    'LEADS-DLQ'
  ),
  leadCase(
    '08',
    'no-idempotency-key',
    'No `idempotencyKey`',
    () => {
      const { idempotencyKey: _, ...lead } = dLead();
      return message(lead);
    },
    false,
    'LEADS-DLQ (`Missing key`)'
  ),
  leadCase(
    '09',
    'empty-idempotency-key',
    'An empty `idempotencyKey`',
    () => message({ ...dLead(), idempotencyKey: '' }),
    true,
    'LEADS-DLQ: the decoder accepts it, but DynamoDB refuses an empty key (`OrderStoreFailed`)'
  ),
  leadCase(
    '10',
    'no-raw',
    'No `raw`',
    () => {
      const { raw: _, ...lead } = dLead();
      return message(lead);
    },
    false,
    'LEADS-DLQ (`Missing key`)'
  ),
  leadCase(
    '11',
    'type-and-raw-disagree',
    '`extraction_source` is `mutation`, but `raw` has business_closure columns',
    () =>
      message({
        ...dLead(),
        extraction_source: 'mutation',
        idempotencyKey: `${String(dLead()['idempotencyKey'])}-mutation`,
      }),
    true,
    '1 order. The columns that mutation does not know are dropped.'
  ),
];

// ---------- E: S3 notifications sent direct to the inbox and lead-sources queues ----------

const notificationCases = (
  prefix: 'E1' | 'E2',
  destination: 'inbox-queue' | 'lead-sources-queue',
  bucketOf: (c: Context) => string,
  stage: string
): Case[] => {
  const eventTime = '2026-10-11T12:00:00.000Z';
  const dlq = `${stage}-DLQ`;
  const missingKey = 'catalog/missing-object.eml';
  const items: [string, string, (c: Context) => unknown, Check, string][] = [
    [
      'test-event',
      'The S3 test event that S3 sends when the notification is set up',
      (c) => ({ Service: 'Amazon S3', Event: 's3:TestEvent', Time: eventTime, Bucket: bucketOf(c) }),
      { kind: 'notification', records: 0 },
      'Acknowledged, and no file is read',
    ],
    ['not-json', 'Text that is not JSON', () => 'not json', { kind: 'notification', throws: true }, dlq],
    ['no-records', 'An event with no records', () => ({ Records: [] }), { kind: 'notification', throws: true }, dlq],
    [
      'record-without-bucket',
      'A record without a bucket name',
      (c) => s3Notification([{ key: missingKey, eventTime }], c.region),
      { kind: 'notification', throws: true },
      dlq,
    ],
    [
      'record-without-event-time',
      'A record without `eventTime`',
      (c) => s3Notification([{ bucket: bucketOf(c), key: missingKey }], c.region),
      { kind: 'notification', throws: true },
      `${dlq}, and no file is read`,
    ],
    [
      'missing-object',
      'A record for an object that does not exist',
      (c) => s3Notification([{ bucket: bucketOf(c), key: missingKey, eventTime }], c.region),
      { kind: 'notification', records: 1 },
      stage === 'INBOX' ? 'A ledger entry is written, then 4 read attempts → INBOX-DLQ' : `4 read attempts → ${dlq}`,
    ],
    [
      'two-records-first-missing',
      'Two records, and the first object does not exist',
      (c) =>
        s3Notification(
          [
            { bucket: bucketOf(c), key: missingKey, eventTime },
            { bucket: bucketOf(c), key: 'catalog/second.eml', eventTime },
          ],
          c.region
        ),
      { kind: 'notification', records: 2 },
      `${dlq} for the whole message. The second record is not processed.`,
    ],
  ];
  return items.map(([slug, title, body, check, expected], index) => ({
    id: `${prefix}-${String(index + 1).padStart(2, '0')}`,
    slug,
    extension: 'json',
    destination,
    title,
    build: (context) => {
      const value = body(context);
      return typeof value === 'string' ? Buffer.from(value) : json(value);
    },
    check,
    expected,
  }));
};

const e: Case[] = [
  ...notificationCases('E1', 'inbox-queue', (context) => context.buckets.inbox, 'INBOX'),
  ...notificationCases('E2', 'lead-sources-queue', (context) => context.buckets.leadSources, 'SRC'),
];

export const cases: readonly Case[] = [
  ...a2,
  ...a3Files,
  ...a3Emails,
  ...a4,
  ...a5,
  ...a6,
  ...a7,
  ...correction,
  ...b,
  ...c,
  ...d,
  ...e,
];
