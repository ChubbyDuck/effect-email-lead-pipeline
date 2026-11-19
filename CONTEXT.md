# Leads pipeline

The path from an inbound email to stored leads: three handlers, two queues between them, and the limits on how much of that path can be in flight at once.

## Language

**Email**:
One inbound message. A simulation starts from a burst of emails.
_Avoid_: Message, event

**Source**:
The workbook taken from one email attachment. It is one message on the sources queue.
_Avoid_: Attachment, src, file

**Lead**:
One lead from a source, carried as one message on the leads queue. After the lead handler stores it, it is an **Order**.
_Avoid_: Row

**Order**:
A lead that the lead handler stored in the Orders table, keyed by its idempotency key. It has the time of its first storage, `storedAt`, which a repeated store does not change. An order that was stored before the time was written has none. The orders dashboard reads the orders; it never changes one.
_Avoid_: Stored lead, item, record

**Order query**:
The input of the orders dashboard: a search text, a source type, a sort, a page, and the key of the open order. The search text and the source type are the **filters** of the query: an order shows only when it matches both. Its result is one **order page**: the rows of that page, the number of that page and the count of the pages, the total of the orders that match the filters, the total of all the stored orders, and the count of each source type after the search and before the type filter. A page has 10, 25, or 50 rows. A page number above the last page gives the last page, and an empty result has one page. When the query has the key of an order, the order page also has the **selected order**: that order, found in all the stored orders and not only in the orders that match the filters, or the statement that no stored order has the key.
_Avoid_: Filter (for the whole query), request, params

**Orders dashboard**:
The user-facing app that lists the orders. It only reads the Orders table. The lab is the internal app next to it.
_Avoid_: Admin, orders monitor

**Deployment**:
One named, complete copy of the pipeline, made by one IaC tool (its tool) in one place: its own handlers, queues, buckets, tables, and inbox address. Many deployments can run at the same time, and they share no data. The lab and the orders dashboard each show one deployment at a time.
_Avoid_: Environment, stack, stage

**Deployment status**:
What the IaC tool of a deployment says about it: the CloudFormation stack for CDK, or the stage in the Alchemy state. Its phase is `complete`, `in-progress`, or `failed`, in the words of no tool. The health rules of the lab read the phase; the page also shows the status in the words of the tool.
_Avoid_: Stack status

**Lab**:
The internal app next to the orders dashboard. It has two sides: it shows the deployed pipeline as it runs, and it models the pipeline with the burst simulator. The comparison joins the two sides.
_Avoid_: Monitor, console, admin

**Burst**:
The emails released together at the start of one simulation.
_Avoid_: Batch, event, run

**Simulation**:
A model of one burst through the pipeline on one shared clock, calculated from the knobs, not observed. It gives the waves, the queue depth over time, the cost of the burst and of N bursts a day for one month, and the limits the knobs break. The burst simulator is the page of the lab that shows it. The page of the lab next to it shows real requests instead.
_Avoid_: Dashboard, V3, scenario, run

**Comparison**:
A simulation of one request drawn with the real runs of that request, on one clock from the time that S3 stored the email. The request sets the shape (one email, its sources, the mean leads of a source, the mean bytes of a row), and the timing knobs stay as the person set them. The real queue depth is an estimate, because the logs show when a handler takes a message, not when the message arrives.
_Avoid_: Overlay, diff, replay

**Comparison summary**:
Many comparisons read together. Each request keeps the model of its own shape, so the summary takes the ratio of each request to its own model first, and then the median and the mean of those ratios. It leaves out a request whose numbers are not whole: an active request, a stage that did not load, a stage with more runs than one read takes, or a run without a REPORT line. Such a request still shows its own values. The summary does not draw a timeline, because a median request has no runs.

**Billing rules**:
How AWS counts the units that it bills: a GB is 2^30 bytes, Lambda bills each started ms at the memory in GB, SES bills each started chunk of 256 KB and at least one, and DynamoDB bills each 1 KB of an item as one write unit. It also fixes the order of the services in a cost split. `packages/shared/src/Core/Shared/Domain/billing.ts` holds the rules and `packages/shared/src/Core/Shared/Domain/prices.ts` holds the prices, so a simulation and the real runs of a request differ in cost only by their quantities.
_Avoid_: Pricing, cost model

**Handler**:
One invocation of a stage. An inbox handler takes one email. A source handler takes one source. A lead handler takes one batch of leads.
_Avoid_: Lambda, worker, consumer

**Handler outcome**:
How an inbox or source handler ends its work on the file of one request: processed, rejected, or failed. A rejection is a failure that a redrive cannot fix, such as an email that does not parse. A processed or rejected file is deleted, because the ledger keeps its status. A failed handler keeps its file, and its message goes to the DLQ, so a redrive can retry it. An interruption is not an outcome.
_Avoid_: Result, envelope, status

**Handler timeline**:
The steps of one warm handler in the simulation, in their order, from the start of its code. A step is one port call, or a run of output waves that each hold the same units and take the same time. The duration of the handler, the ranges the simulator draws, what the handlers of a stage put out together, and the releases into the next queue all come from it. A cold handler runs INIT before the first step.
_Avoid_: Spans, trace, phases

**Batch**:
The leads one lead handler takes in a single invocation.
_Avoid_: Wave, chunk, page

**Stage cap**:
How many handlers of one stage may run at once.
_Avoid_: Pool, maximum concurrency

**Order write limit**:
The most writes into the orders table in one second: 2,000. Each execution environment of the lead stage takes its writes from its own bucket of 10 a second, and the stage cap of 200 bounds the environments that run at once. A retry is a write too. The limit sets a maximum rate. The stage cap sets only how many handlers run at once, and a faster handler writes more each second.
_Avoid_: Throttle, quota

**Wave**:
Work that starts together and finishes together because every member takes the same time. A wave of handlers is bounded by the stage cap. A wave inside one handler is the puts, sends, or stores running together, bounded by that handler's wave width. Same shape, different scale.
_Avoid_: Pass, batch

**Queue depth**:
Messages released into a queue and not yet taken by a handler. It rises when a handler emits and falls when a handler takes.
_Avoid_: Water level, backlog, in flight

**Lane**:
What the simulator shows for one stage: the waves of its handlers, the ranges of each wave, all its handlers together as one swarm, and the queue depth in front of it. A simulation gives one lane for each stage. A comparison gives a second lane for each stage from the real runs, and each run is a wave of one handler. The same rules make both lanes, so they differ only where the model and the logs differ.
_Avoid_: Track, row, channel

**Request**:
The work that one email starts, from the inbox handler to the stored leads. Its ID is the SES message ID of the email. The stages are linked only through S3 and SQS, so each stage reads the ID from what it receives: the inbox and source handlers from the key of their file, and the lead handler from the body of each queued lead. Each carrier has one owner that writes it and reads it back: `packages/shared/src/Core/Shared/Domain/keys.ts` for the keys, and `packages/pipeline/src/Core/Pipeline/Domain/queuedLead.ts` for the body of a queued lead.
_Avoid_: Job, run, ticket, invocation

**Standalone source**:
A source whose key is not in the folder of an email, such as a manual upload. It is a request of its own, with a hash of its location as the ID.
_Avoid_: Orphan source, manual request

**Request ledger**:
The table with one entry for each request. The entry shows the inbox status of the email and the progress of its sources and leads. The lab reads the entries that changed since a time, to show each request live. An entry is deleted one week after its last change.
_Avoid_: Request log, status table, tracker

**Progress**:
One change of a request entry that a handler writes as soon as it knows a fact: a new inbox status, the number of attachments, or a delta for a counter of sources or leads. Each handler adds to `pending` when it starts, and moves the same amount from `pending` to `processed`, `rejected`, or `failed` when it ends.
_Avoid_: Status update, event, metric

**Request trail**:
What the runs of one request say about it: the progress that each run wrote, the files that each run read, and the files of the request, one for each key. A retry reads the same file again, so a file counts once, with its largest size and with the most leads that one of its runs found. A lead run takes the leads of many requests, so the request has only its share of that run.
_Avoid_: Run log, history, events

**Request details**:
What the sheet of one request shows: the entry that the server read, the runs in the search window of that entry, the stages that the logs could not give, the tally of the runs, and the cost of the request. The server picks the window from the entry, so a page sends only the request ID, and the window and the cost come from the same read. `requestDetailsOf` in `apps/lab/src/Core/Observation/Domain/details.ts` makes them.
_Avoid_: Run read, request runs

**Search window**:
The time in which the runs of one request write their log lines: from a little before the email came in to a little after the last change of the entry, or until now while the request is active. It is never longer than the longest search. Only `searchWindowOf` in `apps/lab/src/Core/Observation/Domain/runs.ts` picks it, and only the server calls it.
_Avoid_: Time range, query window

**Status assessment**:
The findings of one snapshot of the deployed pipeline and the worst of their levels. Newer counts of the queues and the buckets go into the snapshot first, and the findings are made at the time of those counts. `assessmentOf` in `apps/lab/src/Core/Observation/Domain/health.ts` is the only source of findings: the boxes, the column heads, and the list of the lab all show them. A message in a queue or an object in a bucket without a finding is work in progress, not a problem.
_Avoid_: Health check, verdict, alert

**Dead-letter cause**:
The run that most likely failed a message of a DLQ, and how the search found it. First a run that names the message, then a failed run of a request of the message, last any failed run that started near the receive. Only a run that names the message is certain. The ReadDeadLetterCause use case finds it through the `LogSearch` port, which only gives the log lines that contain a term, so a fake of the logs can test each step.
_Avoid_: DLQ reason, root cause
