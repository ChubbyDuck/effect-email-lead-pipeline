import { expect, test } from 'vitest';

import { toDlqMessage } from './dlq';
import { entryOf, objectsOf, requestIDsOf } from './dlqClues';

const requestID = 'asadknf92cjtguqubh3cnp0j1nm73i9e6fp7ci01';

const s3Message = (bucket: string, key: string) =>
  toDlqMessage({
    MessageId: 'm1',
    Body: JSON.stringify({ Records: [{ s3: { bucket: { name: bucket }, object: { key } } }] }),
    Attributes: { ApproximateFirstReceiveTimestamp: '1791927002399', SentTimestamp: '1791927002397' },
  });

test('reads the request of a source from the folder of its key', () => {
  const message = s3Message('leads-lead-sources', `13-10-2026/21-20/${requestID}/03-business+closure.pdf`);

  expect(requestIDsOf('leadSources', message)).toEqual([requestID]);
});

test('reads the objects of a message with the keys as the handler reads them, and none of a lead', () => {
  const message = s3Message('leads-lead-sources', `13-10-2026/21-20/${requestID}/03-business+closure%C3%A9.pdf`);

  expect(objectsOf('leadSources', message)).toEqual([
    { bucket: 'leads-lead-sources', key: `13-10-2026/21-20/${requestID}/03-business closureé.pdf` },
  ]);
  expect(objectsOf('leads', message)).toEqual([]);
});

test('reads the request of an email from the name of its object', () => {
  expect(requestIDsOf('inbox', s3Message('leads-inbox', `received/${requestID}`))).toEqual([requestID]);
});

test('gives a source outside the folder of an email the hash of its location, as the handler does', () => {
  const [hash] = requestIDsOf('leadSources', s3Message('leads-lead-sources', 'manual/upload.pdf'));

  expect(hash).toMatch(/^[0-9a-f]{40}$/);
});

test('reads the request that a lead message names', () => {
  const message = toDlqMessage({ MessageId: 'm2', Body: JSON.stringify({ lead: {}, requestID }) });

  expect(requestIDsOf('leads', message)).toEqual([requestID]);
  expect(requestIDsOf('leads', toDlqMessage({ MessageId: 'm3', Body: 'not json' }))).toEqual([]);
});

test('takes the receive time of the handler from the first receive of the message', () => {
  const message = s3Message('leads-lead-sources', `13-10-2026/21-20/${requestID}/01-mutation`);

  expect(entryOf('leadSources', message)).toEqual({
    message,
    objects: [{ bucket: 'leads-lead-sources', key: `13-10-2026/21-20/${requestID}/01-mutation` }],
    requestIDs: [requestID],
    receivedAt: new Date(1791927002399).toISOString(),
  });
});
