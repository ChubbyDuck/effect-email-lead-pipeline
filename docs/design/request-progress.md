# Request Progress in the Request Ledger

**Design record** (initially decided 12 Oct 2026; updated to reflect the current codebase).  
**Source of truth:** [`request.ts`](../../packages/shared/src/Core/Shared/Domain/request.ts) (domain model & transitions) · [`RequestLedger.ts`](../../packages/shared/src/Core/Shared/Ports/RequestLedger.ts) (port) · [`RequestLedger/live.ts`](../../packages/shared/src/Infrastructure/Shared/RequestLedger/live.ts) (DynamoDB adapter) · [`progress.ts`](../../packages/pipeline/src/Core/Pipeline/Application/progress.ts) (best-effort recorder).

---

## Problem

The three pipeline stages are decoupled through S3 and SQS: no handler calls the next directly. Without a shared progress record, answering basic operational questions about a single email — *how many workbooks did it contain, how many leads are still queued, and did anything fail?* — requires correlating CloudWatch log groups across three Lambdas and counting by hand.

## Design overview

Every inbound email owns **one flat DynamoDB item** in the **Request ledger**, keyed by its branded [`RequestID`](../../packages/shared/src/Core/Shared/Domain/request.ts) (the SES message ID, or a location hash for standalone uploads). Each stage writes facts to that item as soon as it learns them:

- **Inbox handler** acknowledges the email as `pending`, records its attachment count once authorized, and writes its final `inboxStatus` (`processed`, `rejected`, or `failed`).
- **Source handlers** increment `sourcesPending` on start, add discovered valid leads to `sourcesLeads` *before* pushing to SQS, and atomically move 1 from `sourcesPending` to `sourcesProcessed`, `sourcesRejected`, or `sourcesFailed` on completion.
- **Lead handlers** group each SQS batch by `requestID` and write once per request per batch — moving the batch slice from `leadsPending` into `leadsProcessed` and `leadsFailed`.

Because sources and leads fan out concurrently across many Lambda invocations, they are modeled as **atomic counters**, not a single status string.

---

## Data model: one flat DynamoDB item

The domain schema (`RequestEntry`) and the DynamoDB item share the exact same flat shape, eliminating translation layers. Any untouched counter is omitted in DynamoDB and treated as `0` on read.

| Attribute | Type | Written by |
| --- | --- | --- |
| `requestID` | Branded string (partition key) | Inbox handler (`acknowledge`) |
| `receivedAt` | ISO-8601 string | Inbox handler (`acknowledge`) |
| `updatedAt` | ISO-8601 string | Every write |
| `expiresAt` | Epoch seconds (DynamoDB TTL, 7 days from last change) | Every write |
| `inboxStatus` | `'pending' \| 'processed' \| 'rejected' \| 'failed'` | Inbox handler |
| `attachments` | Integer (set once after authorization) | Inbox handler |
| `sourcesPending` | Counter | Source handler |
| `sourcesProcessed` | Counter | Source handler |
| `sourcesRejected` | Counter | Source handler |
| `sourcesFailed` | Counter | Source handler |
| `sourcesLeads` | Counter (valid leads extracted across all sources) | Source handler |
| `leadsPending` | Counter | Lead handler |
| `leadsProcessed` | Counter | Lead handler |
| `leadsRejected` | Counter (reserved for stage symmetry; no current writer) | — |
| `leadsFailed` | Counter | Source handler (unpushed leads) & Lead handler |

**Derived queue depths (computed on read, never stored):**
- Sources waiting in queue = `attachments − (sourcesPending + sourcesProcessed + sourcesRejected + sourcesFailed)`
- Leads waiting in queue = `sourcesLeads − (leadsPending + leadsProcessed + leadsRejected + leadsFailed)`

A 7-day rolling TTL (`expiresAt`, refreshed on every update) keeps the table bounded so the Lab's periodic scans stay inexpensive.

---

## Pure transitions & order-independent DynamoDB updates

- **Pure domain transitions ([`request.ts`](../../packages/shared/src/Core/Shared/Domain/request.ts)):** A `RequestProgress` value carries an optional `inboxStatus`, optional `attachments`, and optional integer counter deltas. Small domain constructors (`inboxEnded`, `attachmentsCounted`, `sourceStarted`, `sourceFoundLeads`, `sourceEnded`, `leadBatchStarted`, `leadBatchEnded`) produce exact transitions that unit tests can verify without DynamoDB.
- **Single atomic `UpdateItem` ([`RequestLedger/live.ts`](../../packages/shared/src/Infrastructure/Shared/RequestLedger/live.ts)):** `RequestLedger.record` compiles a `RequestProgress` into one DynamoDB `UpdateItem` using `SET` for scalar fields (`updatedAt`, `expiresAt`, `inboxStatus`, `attachments`) and `ADD` for non-zero counter deltas. Because DynamoDB `ADD` on a top-level number is atomic and initializes missing attributes at `0`:
  - concurrent handlers never clobber each other,
  - decrementing `pending` and incrementing an outcome counter happen in one atomic write, and
  - out-of-order writes (including standalone source uploads that never pass through `HandleInbox`) still produce a valid item.
- **Idempotent acknowledgement:** `RequestLedger.acknowledge` uses a conditional `PutItem` (`attribute_not_exists(requestID)`), so duplicate S3 deliveries or redrives never reset an existing entry back to `pending`.

---

## When each handler writes

1. **Inbox handler ([`HandleInbox/handler.ts`](../../packages/pipeline/src/Core/Pipeline/Application/UseCases/HandleInbox/handler.ts)):**
   - **Start:** `acknowledge` (strict — failure here fails the handler and dead-letters the message).
   - **After `Guard.authorize`:** `attachmentsCounted(n)` — recorded *after* authorization so rejected/unauthorized emails never skew expected source counts.
   - **End (via [`withHandlerOutcome`](../../packages/pipeline/src/Core/Pipeline/Application/outcome.ts)):** `processed` once all attachments are stored, `rejected` on `EmailNotParsed` / `Unauthorized`, or `failed` on `InboxEventNotHandled`. Processed and rejected emails are then deleted from S3; a delete warning never alters the recorded outcome.
2. **Source handler ([`HandleLeadSources/handler.ts`](../../packages/pipeline/src/Core/Pipeline/Application/UseCases/HandleLeadSources/handler.ts)):**
   - **Start:** `sourceStarted()` (`sourcesPending +1`).
   - **Before pushing leads:** `sourceFoundLeads(n)` (`sourcesLeads +n`) — written *before* the first SQS send so no lead handler can finish a lead before the ledger counts it.
   - **End:** `sourcesPending -1` and `+1` to `sourcesProcessed`, `sourcesRejected`, or `sourcesFailed` (plus `leadsFailed +k` if `k` leads could not be pushed). Invalid rows alongside valid ones are logged as warnings and excluded from `sourcesLeads`.
3. **Lead handler ([`HandleLead/handler.ts`](../../packages/pipeline/src/Core/Pipeline/Application/UseCases/HandleLead/handler.ts)):**
   - Groups incoming SQS records by the `requestID` carried in each queued lead payload (malformed records without a readable `requestID` are logged and dead-lettered without touching the ledger).
   - **Start:** `leadBatchStarted(count)` once per request in the batch (`leadsPending +count`).
   - **End:** `leadBatchEnded({ processed, failed })` once per request (`leadsPending -count`, `leadsProcessed +processed`, `leadsFailed +failed`).

---

## Failure policy: observability must never break the pipeline

Progress recording lives in [`makeProgressRecorder`](../../packages/pipeline/src/Core/Pipeline/Application/progress.ts):

- **Log first, write second:** Every `record` call logs a structured `Progress of request <id>: {json}` line *before* calling DynamoDB. Even if DynamoDB fails, CloudWatch Logs still tie the Lambda invocation to the request — which powers the Lab's per-request run timeline and Comparison view.
- **Retries & full error isolation:** Each `record` retries with `retryPolicy(config)`. If it still fails with `RequestNotRecorded` **or throws an unexpected defect**, `progress.ts` catches both (`Effect.catch` and `Effect.catchDefect`) and logs a warning. Progress writes never fail a handler or send messages to a DLQ.
- **Exactly-once end write:** `progress.makeEnd(requestID)` guards the end transition with an Effect `Ref.getAndSet(ended, true)`, so a late failure (such as an S3 delete defect after `processed` was already recorded) can never record a second end.
- **Interruption:** On Lambda timeout or `SIGTERM` fiber interruption, no end is written — leaving `pending > 0` so the operator can see the handler did not finish cleanly.
- **Least-privilege IAM:** Only the inbox handler gets `dynamodb:PutItem`; all three handlers get `dynamodb:UpdateItem`.

---

## Trade-offs & known limits

- **Counters track attempts, not deduplicated orders:** Redriving a failed source or lead adds another attempt (`sourcesFailed: 1` and `sourcesProcessed: 1` is expected after a successful redrive). Similarly, uploading the same workbook twice increments `leadsProcessed` each time while the Orders table keeps one deduplicated item.
- **SDK retry drift:** If the AWS SDK retries an `UpdateItem` that timed out after succeeding server-side, a counter can double-count. We accept this minor drift for observability rather than complicating writes with transactional deduplication.
- **Per-item throughput headroom:** DynamoDB sustains ~1,000 writes/s per partition key. With 2 ledger writes per request per 10-lead batch, even peak lead concurrency (`200` handlers) stays well below the per-item ceiling.
- **Derived queue depths:** Can briefly dip below `0` only if an earlier `attachments` or `sourcesLeads` write failed after all retries (visible via its warning log).
