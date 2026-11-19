import { Effect, Schema } from 'effect';
import { expect, test } from 'vitest';

import { toLeadsAndRejectionsFromRecords } from '#Core/Pipeline/Domain/Transformations/leads';

const newAcquisition = {
  extraction_source: 'new_acquisition',
  idempotencyKey: 'key',
  extracted: { name: 'Acme' },
  raw: { Name: 'Acme' },
};

const businessClosure = {
  extraction_source: 'business_closure',
  idempotencyKey: 'key',
  extracted: { name: 'Beta' },
  raw: { Name: 'Beta' },
};

const queuedRecord = (messageId: string, body: string) => ({ messageId, body });

const queuedLead = (messageId: string, lead: unknown, requestID = 'source-request') =>
  queuedRecord(messageId, JSON.stringify({ lead, requestID }));

test('toLeadsAndRejectionsFromRecords maps each SQS message id to the lead and the request in its body', async () => {
  const { leads, leadRejections } = await Effect.runPromise(
    toLeadsAndRejectionsFromRecords([
      queuedLead('message-1', newAcquisition),
      queuedLead('message-2', businessClosure, 'other-request'),
    ])
  );

  expect([...leads.keys()]).toEqual(['message-1', 'message-2']);
  expect([...leads.values()].map(({ lead, requestID }) => [lead.extraction_source, requestID])).toEqual([
    ['new_acquisition', 'source-request'],
    ['business_closure', 'other-request'],
  ]);
  expect(leadRejections).toEqual([]);
});

test('toLeadsAndRejectionsFromRecords rejects records whose body is not a lead message', async () => {
  const malformedJson = queuedRecord('message-1', 'not json');
  const nullBody = queuedRecord('message-2', 'null');
  const missingLead = queuedRecord('message-3', '{}');
  const arrayBody = queuedRecord('message-4', '[]');
  const invalidLead = queuedLead('message-5', { extraction_source: 'unknown' });
  const withoutRequestID = queuedRecord('message-7', JSON.stringify({ lead: newAcquisition }));
  const { leads, leadRejections } = await Effect.runPromise(
    toLeadsAndRejectionsFromRecords([
      malformedJson,
      nullBody,
      missingLead,
      arrayBody,
      invalidLead,
      queuedLead('message-6', businessClosure),
      withoutRequestID,
    ])
  );

  expect([...leads.entries()].map(([messageId, { lead }]) => [messageId, lead.extraction_source])).toEqual([
    ['message-6', 'business_closure'],
  ]);
  expect(leadRejections.map(({ index, messageId, input }) => ({ index, messageId, input }))).toEqual([
    { index: 0, messageId: 'message-1', input: malformedJson },
    { index: 1, messageId: 'message-2', input: nullBody },
    { index: 2, messageId: 'message-3', input: missingLead },
    { index: 3, messageId: 'message-4', input: arrayBody },
    { index: 4, messageId: 'message-5', input: invalidLead },
    { index: 6, messageId: 'message-7', input: withoutRequestID },
  ]);
  expect(leadRejections.every(({ error }) => Schema.isSchemaError(error))).toBe(true);
});
