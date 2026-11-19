import { RequestID } from '@leads/shared/domain/request';
import { Lead } from '@leads/shared/domain/types';
import { Effect, Schema } from 'effect';
import { expect, test } from 'vitest';

import { decodeQueuedLead, encodeQueuedLead } from './queuedLead';

const lead = Schema.decodeSync(Lead)({
  extraction_source: 'new_acquisition',
  idempotencyKey: 'key',
  extracted: { name: 'Acme' },
  raw: { Name: 'Acme' },
});
const requestID = RequestID.make('source-request');

test('reads back the lead and the request of a body that it wrote', async () => {
  const body = encodeQueuedLead({ lead, requestID });

  expect(typeof body).toBe('string');
  await expect(Effect.runPromise(decodeQueuedLead(body))).resolves.toEqual({ lead, requestID });
});

test('rejects a body without the request of its lead', async () => {
  const error = await Effect.runPromise(decodeQueuedLead(JSON.stringify({ lead })).pipe(Effect.flip));

  expect(Schema.isSchemaError(error)).toBe(true);
});
