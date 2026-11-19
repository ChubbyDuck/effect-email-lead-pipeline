import { Effect } from 'effect';

import type { RequestEntry } from '#Core/Shared/Domain/request';
import {
  RequestLedger,
  RequestNotAcknowledged,
  RequestNotRead,
  RequestNotRecorded,
  RequestsNotListed,
} from '#Core/Shared/Ports/RequestLedger';
import { definePortMock } from '#Core/Shared/Ports/testing/variants';

const requestLedgerMock = definePortMock(RequestLedger, ({ method, record: call, observation }) => {
  const acknowledge = call('acknowledge');
  const record = call('record');
  const changedSince = call('changedSince');
  const entryOf = call('entryOf');
  const noEntries: readonly RequestEntry[] = [];

  return {
    variants: {
      acknowledge: method('acknowledge', {
        failsWithRequestNotAcknowledged: (request) =>
          acknowledge(request).pipe(
            Effect.andThen(Effect.fail(new RequestNotAcknowledged({ request, reason: 'unavailable' })))
          ),
        succeeds: acknowledge,
      }),
      record: method('record', {
        failsWithRequestNotRecorded: (requestID, progress) =>
          record(requestID, progress).pipe(
            Effect.andThen(Effect.fail(new RequestNotRecorded({ requestID, progress, reason: 'unavailable' })))
          ),
        succeeds: record,
      }),
      changedSince: method('changedSince', {
        failsWithRequestsNotListed: (since) =>
          changedSince(since).pipe(
            Effect.andThen(Effect.fail(new RequestsNotListed({ since, reason: 'unavailable' })))
          ),
        succeedsWithNoEntries: (since) => changedSince(since).pipe(Effect.as(noEntries)),
      }),
      entryOf: method('entryOf', {
        failsWithRequestNotRead: (requestID) =>
          entryOf(requestID).pipe(
            Effect.andThen(Effect.fail(new RequestNotRead({ requestID, reason: 'unavailable' })))
          ),
        succeedsWithNoEntry: (requestID) => entryOf(requestID).pipe(Effect.as(undefined)),
      }),
    },
    observation,
  };
});

export const requestLedgerBuilder = requestLedgerMock.builder;
export const makeRequestLedger = requestLedgerMock.make;
