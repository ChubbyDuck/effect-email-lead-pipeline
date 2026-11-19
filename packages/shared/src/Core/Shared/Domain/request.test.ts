import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

import {
  attachmentsCounted,
  fileSizeLogMessage,
  fileSizeOfLogMessage,
  inboxEnded,
  leadBatchEnded,
  leadBatchStarted,
  leadsInQueue,
  pendingRequest,
  progressLogMessage,
  progressOfLogMessage,
  RequestEntry,
  RequestID,
  sourceEnded,
  sourcesInQueue,
  sourceFoundLeads,
  sourceStarted,
} from './request';

test('a request starts as pending when its email comes in', () => {
  const receivedAt = new Date('2026-10-11T08:30:00.000Z');

  expect(pendingRequest(RequestID.make('message-id'), receivedAt)).toEqual({
    requestID: 'message-id',
    receivedAt,
    inboxStatus: 'pending',
  });
});

describe('inbox', () => {
  test.each(['processed', 'rejected', 'failed'] as const)('an inbox that ended as %s sets that status', (status) => {
    expect(inboxEnded(status)).toEqual({ inboxStatus: status });
  });

  test('the attachments of an email are counted once, also when there are none', () => {
    expect(attachmentsCounted(3)).toEqual({ attachments: 3 });
    expect(attachmentsCounted(0)).toEqual({ attachments: 0 });
  });
});

describe('sources', () => {
  test('a source that starts is pending', () => {
    expect(sourceStarted()).toEqual({ sourcesPending: 1 });
  });

  test('a source adds its valid leads to the leads of the request', () => {
    expect(sourceFoundLeads(12)).toEqual({ sourcesLeads: 12 });
  });

  test.each([
    ['processed', { sourcesPending: -1, sourcesProcessed: 1 }],
    ['rejected', { sourcesPending: -1, sourcesRejected: 1 }],
    ['failed', { sourcesPending: -1, sourcesFailed: 1 }],
  ] as const)('a source that ended as %s moves from pending to that outcome', (outcome, progress) => {
    expect(sourceEnded(outcome)).toEqual(progress);
  });

  test('a failed source counts the leads that it did not push as failed leads', () => {
    expect(sourceEnded('failed', 4)).toEqual({ sourcesPending: -1, sourcesFailed: 1, leadsFailed: 4 });
  });
});

describe('leads', () => {
  test('a lead batch makes the leads of one request pending', () => {
    expect(leadBatchStarted(5)).toEqual({ leadsPending: 5 });
  });

  test('a lead batch that ended moves the leads of one request from pending to their outcomes', () => {
    expect(leadBatchEnded({ processed: 3, failed: 2 })).toEqual({
      leadsPending: -5,
      leadsProcessed: 3,
      leadsFailed: 2,
    });
  });

  test('a lead batch that ended gives no delta to an outcome without leads', () => {
    expect(leadBatchEnded({ processed: 4, failed: 0 })).toEqual({ leadsPending: -4, leadsProcessed: 4 });
    expect(leadBatchEnded({ processed: 0, failed: 1 })).toEqual({ leadsPending: -1, leadsFailed: 1 });
  });
});

describe('entry', () => {
  const decode = Schema.decodeUnknownSync(RequestEntry);
  const noCounters = {
    sourcesPending: 0,
    sourcesProcessed: 0,
    sourcesRejected: 0,
    sourcesFailed: 0,
    sourcesLeads: 0,
    leadsPending: 0,
    leadsProcessed: 0,
    leadsRejected: 0,
    leadsFailed: 0,
  };

  test('an entry reads the stored item as it is, with its ISO strings as dates', () => {
    const item = {
      requestID: 'message-id',
      receivedAt: '2026-10-12T08:30:00.000Z',
      updatedAt: '2026-10-12T08:31:10.000Z',
      inboxStatus: 'processed',
      attachments: 2,
      sourcesPending: 0,
      sourcesProcessed: 1,
      sourcesRejected: 1,
      sourcesFailed: 0,
      sourcesLeads: 15,
      leadsPending: 3,
      leadsProcessed: 10,
      leadsRejected: 0,
      leadsFailed: 2,
    };

    expect(decode(item)).toEqual({
      ...item,
      receivedAt: new Date('2026-10-12T08:30:00.000Z'),
      updatedAt: new Date('2026-10-12T08:31:10.000Z'),
    });
  });

  test('an entry counts 0 for a counter that no change touched', () => {
    const entry = decode({
      requestID: 'message-id',
      receivedAt: '2026-10-12T08:30:00.000Z',
      updatedAt: '2026-10-12T08:30:00.000Z',
      inboxStatus: 'pending',
    });

    expect(entry).toEqual({
      requestID: 'message-id',
      receivedAt: new Date('2026-10-12T08:30:00.000Z'),
      updatedAt: new Date('2026-10-12T08:30:00.000Z'),
      inboxStatus: 'pending',
      ...noCounters,
    });
  });

  test('an entry that a source handler made before the acknowledgement has no arrival, status, or attachments', () => {
    const entry = decode({ requestID: 'manual-upload', updatedAt: '2026-10-12T08:30:00.000Z', sourcesPending: 1 });

    expect(entry).toEqual({
      requestID: 'manual-upload',
      updatedAt: new Date('2026-10-12T08:30:00.000Z'),
      ...noCounters,
      sourcesPending: 1,
    });
  });

  test('an entry refuses an inbox status that is not a request status', () => {
    expect(() =>
      decode({ requestID: 'message-id', updatedAt: '2026-10-12T08:30:00.000Z', inboxStatus: 'done' })
    ).toThrow('Expected "pending" | "processed" | "rejected" | "failed"');
  });

  const entryOf = (fields: Partial<RequestEntry>): RequestEntry => ({
    requestID: RequestID.make('message-id'),
    updatedAt: new Date('2026-10-12T08:30:00.000Z'),
    ...noCounters,
    ...fields,
  });

  test('the sources in the queue are the attachments that no source handler took yet', () => {
    const entry = entryOf({
      attachments: 7,
      sourcesPending: 1,
      sourcesProcessed: 2,
      sourcesRejected: 1,
      sourcesFailed: 1,
    });

    expect(sourcesInQueue(entry)).toBe(2);
  });

  test('the sources in the queue are not known before the inbox handler counts the attachments', () => {
    expect(sourcesInQueue(entryOf({ sourcesPending: 1 }))).toBeUndefined();
  });

  test('the leads in the queue are the leads found that no lead handler took yet', () => {
    const entry = entryOf({ sourcesLeads: 20, leadsPending: 4, leadsProcessed: 9, leadsRejected: 1, leadsFailed: 2 });

    expect(leadsInQueue(entry)).toBe(4);
  });
});

describe('the log message of a progress write', () => {
  const requestID = RequestID.make('aj8bllniv9qsu5f5gq1jg5v1fkk2grjeqa4u1381');

  test('names the request, so that a search for the request ID finds the run that wrote it', () => {
    expect(progressLogMessage(requestID, sourceFoundLeads(15))).toBe(
      'Progress of request aj8bllniv9qsu5f5gq1jg5v1fkk2grjeqa4u1381: {"sourcesLeads":15}'
    );
  });

  test('gives back the request and the change from the message', () => {
    const message = `[17:15:34.120] INFO (#3): ${progressLogMessage(requestID, sourceEnded('processed'))}\n`;

    expect(progressOfLogMessage(message.replace(/^\[\S+\] INFO \(#\d+\): /, ''))).toEqual({
      requestID,
      progress: { sourcesPending: -1, sourcesProcessed: 1 },
    });
  });

  test.each([
    'Runtime settings are stale',
    'Progress of request x: not json',
    'Progress of request x: [1]',
    'Progress of request x: {"leadsPending":"10"}',
    'Progress of request x: {"inboxStatus":"lost"}',
  ])('has no change in %j', (message) => {
    expect(progressOfLogMessage(message)).toBeUndefined();
  });
});

describe('the log message of a file size', () => {
  const requestID = RequestID.make('aj8bllniv9qsu5f5gq1jg5v1fkk2grjeqa4u1381');
  const size = { kind: 'email', key: 'inbox/aj8bllniv9qsu5f5gq1jg5v1fkk2grjeqa4u1381', bytes: 300_000 } as const;

  test('names the request, so that a search for the request ID finds the run that wrote it', () => {
    expect(fileSizeLogMessage(requestID, size)).toBe(
      'File size of request aj8bllniv9qsu5f5gq1jg5v1fkk2grjeqa4u1381: {"kind":"email","key":"inbox/aj8bllniv9qsu5f5gq1jg5v1fkk2grjeqa4u1381","bytes":300000}'
    );
  });

  test('gives back the request and the size from the message', () => {
    const source = { kind: 'source', key: 'sources/2026-10-13/17-15/a/01-leads.xlsx', bytes: 12_345 } as const;

    expect(fileSizeOfLogMessage(`${fileSizeLogMessage(requestID, source)}\n`)).toEqual({ requestID, size: source });
  });

  test.each([
    'Runtime settings are stale',
    'Progress of request x: {"sourcesLeads":15}',
    'File size of request x: not json',
    'File size of request x: {"kind":"attachment","key":"a","bytes":1}',
    'File size of request x: {"kind":"email","bytes":1}',
    'File size of request x: {"kind":"email","key":"a","bytes":-1}',
    'File size of request x: {"kind":"email","key":"a","bytes":"1"}',
  ])('has no size in %j', (message) => {
    expect(fileSizeOfLogMessage(message)).toBeUndefined();
  });
});
