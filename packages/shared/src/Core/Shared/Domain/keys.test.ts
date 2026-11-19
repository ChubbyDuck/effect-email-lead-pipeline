import { describe, expect, test } from 'vitest';

import { RequestID } from '#Core/Shared/Domain/request';
import { File } from '#Core/Shared/Domain/types';

import { originOfSource, requestFolderOf, requestIDOfEmail, sourceKey } from './keys';

const messageID = RequestID.make('o3vrnil0e2ic28trm7dfhrc2v0clambda4nbp0g1');
const email = (key: string) => File.make({ bucket: 'inbox', key });
const source = (key: string) => File.make({ bucket: 'lead-sources', key });
const folderOf = (requestID: RequestID) => ({ folder: '27-09-2026', subFolder: '14-30', requestID });

describe('requestIDOfEmail', () => {
  test('takes the SES message ID from the name of the email object', () => {
    expect(requestIDOfEmail(email(`received/${messageID}`))).toBe(messageID);
    expect(requestIDOfEmail(email(messageID))).toBe(messageID);
  });

  test('hashes a key that SES did not write into the same shape, the same way every time', () => {
    const requestID = requestIDOfEmail(email('received/test email.eml'));

    expect(requestID).toMatch(/^[0-9a-f]{40}$/);
    expect(requestIDOfEmail(email('received/test email.eml'))).toBe(requestID);
    expect(requestIDOfEmail(email('received/other.eml'))).not.toBe(requestID);
    expect(requestIDOfEmail(File.make({ bucket: 'other', key: 'received/test email.eml' }))).not.toBe(requestID);
  });
});

describe('requestFolderOf', () => {
  test('puts the request in the folder of its day and of its time, rounded down to 10 minutes', () => {
    expect(requestFolderOf(new Date(2026, 8, 27, 14, 37, 59), messageID)).toEqual(folderOf(messageID));
    expect(requestFolderOf(new Date(2026, 8, 27, 14, 30), messageID)).toEqual(folderOf(messageID));
    expect(requestFolderOf(new Date(2026, 0, 5, 9, 9), messageID)).toEqual({
      folder: '05-01-2026',
      subFolder: '09-00',
      requestID: messageID,
    });
  });
});

describe('sourceKey', () => {
  test('puts the source in the folder of its request, after its 1-based position', () => {
    expect(sourceKey({ ...folderOf(messageID), index: 1, filename: 'Business Closure.xlsx' })).toBe(
      `27-09-2026/14-30/${messageID}/02-business-closure`
    );
    expect(sourceKey({ ...folderOf(messageID), index: 11, filename: 'leads.xlsx' })).toBe(
      `27-09-2026/14-30/${messageID}/12-leads`
    );
  });

  test.each([undefined, '', '.xlsx', '!!!.xlsx'])(
    "names the source 'attachment' when the file name %j has no usable name",
    (filename) => {
      expect(sourceKey({ ...folderOf(messageID), index: 0, filename })).toBe(
        `27-09-2026/14-30/${messageID}/01-attachment`
      );
    }
  );
});

describe('originOfSource', () => {
  test.each([
    ['an SES message ID', messageID],
    ['a hash of an email location', requestIDOfEmail(email('received/test email.eml'))],
  ])('reads back the request that sourceKey wrote, for %s', (_, requestID) => {
    const key = sourceKey({ ...folderOf(requestID), index: 0, filename: 'leads.xlsx' });

    expect(originOfSource(source(key))).toEqual({ _tag: 'FromEmail', requestID });
  });

  test.each(['received/leads.xlsx', 'leads.xlsx', '27-09-2026/14-30/12345678-1234-4234-8234-123456789abc/leads'])(
    'makes %s a standalone request with a hash of its location, the same way every time',
    (key) => {
      const origin = originOfSource(source(key));

      expect(origin._tag).toBe('Standalone');
      expect(origin.requestID).toMatch(/^[0-9a-f]{40}$/);
      expect(originOfSource(source(key))).toEqual(origin);
      expect(originOfSource(source(`${key}-other`)).requestID).not.toBe(origin.requestID);
    }
  );
});
