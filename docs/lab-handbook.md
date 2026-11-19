# Web Apps Handbook (Lab & Orders Dashboard)

A practical guide for humans and coding agents driving the **Lab** ([`apps/lab`](../apps/lab)) — both its **Pipeline Monitor** (`/`) and **Burst Simulator** (`/simulator`) — and the **Orders dashboard** ([`apps/dashboard`](../apps/dashboard)).

Domain terminology follows [`CONTEXT.md`](../CONTEXT.md). For architecture rules and workspace scripts, see [`AGENTS.md`](../AGENTS.md).

---

## 1. Starting the apps

Run every command from the repository root.

| App | Default port | Real AWS (`AWS_PROFILE` required) | Local Floci (no AWS account) |
| --- | --- | --- | --- |
| **Lab** | `4780` | `AWS_PROFILE=<profile> DEPLOYMENT=<name> pnpm lab` | `DEPLOYMENT=local-alchemy pnpm lab:local` |
| **Orders dashboard** | `4790` | `AWS_PROFILE=<profile> DEPLOYMENT=<name> pnpm dashboard` | `DEPLOYMENT=local-alchemy pnpm dashboard:local` |

Important notes:

- **Default `DEPLOYMENT`:** `pnpm lab` and `pnpm dashboard` default to `production-cdk`. Pass `DEPLOYMENT=production-alchemy` for the Alchemy AWS deployment. Check `AGENTS.local.md` (when present) for the machine's `AWS_PROFILE`.
- **Local Floci choice:** `pnpm lab:local` defaults to `local-cdk`, whose production Lambda bundles cannot read AppConfig inside Floci. Prefer `local-alchemy` (`pnpm floci:alchemy:up` → `DEPLOYMENT=local-alchemy pnpm infra:deploy:floci` → `DEPLOYMENT=local-alchemy pnpm lab:local`).
- **Multiple instances:** Set `PORT=<port>` to run two Lab or Dashboard instances simultaneously (for example, comparing two deployments).
- **Cleanup:** Stop dev servers and any Floci containers you started (`pnpm floci:alchemy:down` or `pnpm floci:down`) when done.

---

## 2. Direct URL shortcuts

Prefer navigating directly by URL instead of clicking through dropdowns or filling search forms:

| View | URL | Notes |
| --- | --- | --- |
| **Monitor (Pipeline flow)** | `http://localhost:4780/?hours=24` | `hours` accepts `1`, `3` (default), `6`, `12`, or `24`. Avoids opening the Radix Select portal. |
| **Burst Simulator** | `http://localhost:4780/simulator` | Opens with the measured defaults from `@leads/shared`. |
| **Simulator Comparison** | `http://localhost:4780/simulator?requests=<id1>,<id2>` | Accepts 1 to 10 comma-separated SES message IDs (legacy `?request=<id>` also works). Loads real CloudWatch runs directly without typing into the form. |
| **Orders dashboard** | `http://localhost:4790/?q=<text>&type=<source>&sort=<col>&dir=<asc\|desc>&page=<n>&size=<10\|25\|50>&order=<key>` | All query state lives in the URL; setting `order=<idempotencyKey>` opens that order's sheet directly. |

---

## 3. Driving the Pipeline Monitor (`/`)

### Live state vs. CloudWatch snapshots
- **Request ledger (`/api/requests`):** Streams live over Server-Sent Events by polling DynamoDB every 2 seconds. The **Requests** card displays the consumed Read Capacity Units (RCUs) of its own polling; click **Pause** if leaving the tab open while doing other work.
- **CloudWatch metrics:** Loaded on page open, window change (`?hours=...`), or explicit **Refresh** (10-second server cache). CloudWatch lags activity by ~1–5 minutes. If the amber **"The metrics can be incomplete"** alert is shown, wait past the timestamp it reports (`Refresh after HH:MM:SS`) and click **Refresh** to read settled run counts, message counts, and DynamoDB write units.
- **Health assessment:** Every card in the **Pipeline** flow (buckets, queues, handlers, DLQs, Orders table) and the summary strip below it (`No problems found` / `N things to look at`) comes from [`assessmentOf`](../apps/lab/src/Core/Observation/Domain/health.ts). Findings distinguish `critical` (failed stack, disabled trigger, non-empty DLQ), `warning` (errors, throttles, duration ≥ 80% of timeout, S3 object older than 15 min, queue backlog older than 5 min), and `info` (deployment in progress).

### Navigating DOM elements & slide-over sheets (`Sheet`)
- **Multiple `<table>` elements exist on `/`:** The live **Requests** card and the bottom resource tabs (**Handlers**, **Queues**, **Buckets**, **Logs**, **Runtime settings**, **Stack**) both render tables. Do **not** use generic selectors like `table tbody tr:first-child`; target a request row by its request ID prefix (`text=<idPrefix>`).
- **Request Details sheet ([`RequestSheet.tsx`](../apps/lab/src/UI/RequestSheet.tsx)):**
  - Click any row in **Requests** to open its slide-over sheet (`[role="dialog"]`).
  - CloudWatch Logs load lazily when the sheet opens. Wait for the **Runs** timeline and **Cost** table to render before reading or taking screenshots.
  - Press `Escape` to close the sheet.
- **DLQ Inspector & Cause Detective ([`DlqSheet.tsx`](../apps/lab/src/UI/DlqSheet.tsx)):**
  - Click any stage's DLQ button (for example, `button:has-text("leads-dlq")`) to open the sheet.
  - **Side effect to know:** Reading a DLQ calls SQS `ReceiveMessage` without deleting messages, which increments each message's `ApproximateReceiveCount` by 1.
  - Click a message row's Subject cell (`[role="dialog"] tbody tr:first-child td:nth-child(4)`) to expand it and run the 3-step CloudWatch Logs Cause Detective (`exact` message ID match → `requestID` match → failure-window match). Wait for the `CAUSE` result (e.g. `A line of this run names the message.`) before snapshotting.
  - Log filter tabs inside the expanded run box switch between `All`, `Handler`, and `Problems`.
  - **Production safety:** **Never click `Redrive` on a production deployment** unless the user explicitly asks you to redrive messages.

---

## 4. Driving the Burst Simulator (`/simulator`) & Comparison

### Inputs & selectors
- **Knobs in the left rail** are `<input type="number">` spinbuttons with explicit `aria-label`s, for example:
  - Workload: `N · Bursts / day`, `E · Emails`, `S · Sources / email`, `L · Leads / source`, `lead_b · Bytes / lead`, `row_b · Bytes / workbook row`
  - Stage caps & internal concurrency: `E_q_c`, `in_c`, `S_q_c`, `src_c`, `L_q_c`, `ld_c`
  - Lead batching & rate limit: `ld_batch`, `ld_window_t`, `ld_writes`, `ld_requests`
  - Memory & timings: `src_M`, `ld_M`, plus collapsible **Inbox timings**, **Source timings**, and **Lead timings** sections
  - Fixed AWS SQS ESM constants: `esm_start` (`5`) and `esm_rate` (`300/min`) are disabled inputs reflecting AWS on-demand SQS event-source mapping behavior.
- **Reset:** Click `button:has-text("Reset sketch")` to restore all defaults.
- **Compare field:** The Request IDs input is a **`<textarea name="requests">`**, not an `<input>`. Prefer navigating directly to `/simulator?requests=<id1>,<id2>`, or type into `textarea[name="requests"]` and click `.compare-panel button:has-text("Compare")`. Click `.compare-panel button:has-text("Clear")` to leave Comparison mode.

### Reading & driving the 6-lane shared-clock timeline
The **Timeline of the handlers** panel renders six synchronized lanes on one clock:
1. `01 Email Queue` (tank)
2. `02 Inbox handler` (waves or swarm)
3. `03 Source Queue` (tank)
4. `04 Source handler` (waves or swarm)
5. `05 Lead Queue` (tank)
6. `06 Lead handler` (waves or swarm)

Tips for driving it:
- **Swarm view vs. Wave-bar view:** Click a handler lane's title button (`Inbox handler`, `Source handler`, `Lead handler`) to toggle between the zoomed-out **swarm** view (ramp-up area chart + in-flight call bursts) and individual painted **wave bars** (with cold-start `INIT` and per-port step colors). If a lane exceeds 2,000 waves, individual bars are skipped and only the swarm/tank updates — lower `E`, `S`, or `L` (for example, `E=10`, `S=4`, `L=200`) to inspect full wave bars across all six lanes.
- **Scrubbing the clock:** Click anywhere inside a handler lane canvas to seek the vertical dashed cursor to that timestamp; all three tanks immediately update to show exact queue depth at that instant. Use the Start / Play / End buttons or `−` / `+` / `Fit` zoom controls (up to `256×`).
- **Triggering AWS & stack limit guardrails ([`limits.ts`](../apps/lab/src/Core/Simulation/Domain/limits.ts)):** Invalid combinations highlight offending knobs in red and display **"The deployed app cannot run these inputs."** with computed safe ceilings. Quick reproducible triggers from defaults:
  - Set `L = 200000` (with `S = 10`) → triggers the **SES 40 MB email bounce limit** (`L` ceiling computed automatically).
  - Set `L_q_c = 250` (with `ld_writes = 10`) → triggers the **2,000 writes/s stack order write limit** (`L_q_c ≤ 200`).
  - Increase `lead_b` so `min(L, 10) × lead_b > 1 MiB` → triggers the **SQS 1 MiB batch ceiling**.

### Comparison mode (`?requests=...`)
- **Single request:** Auto-locks `E = 1`, observed `S`, mean `L`, and mean `row_b` (dashed inputs in the left rail) while keeping your timing knobs editable. Renders stage latency & AWS cost comparison tables, then overlays **`REAL`** CloudWatch runs directly underneath **`MODEL`** waves on the shared clock.
- **Multiple requests (2–10 IDs):** Compares each request against its own shape's model first, then renders a **Comparison summary** with median, mean, min, and max real-to-model ratios across stages and AWS services. Still-active, failed-read, or truncated requests are automatically excluded from the aggregate ratios while still listed individually.

---

## 5. Driving the Orders Dashboard (`:4790`)

- Strictly read-only view of the DynamoDB Orders table.
- All filters, sorting, pagination (`10`, `25`, `50`), and the open `OrderSheet` key are stored in URL search parameters (`q`, `type`, `sort`, `dir`, `page`, `size`, `order`).
- The server caches the Orders table scan for 10 seconds ([`cache.ts`](../apps/dashboard/src/Infrastructure/Orders/OrderReader/cache.ts)). Clicking **Refresh** sets `fresh: true` to bypass the cache and re-scan DynamoDB.

---

## 6. Privacy & screenshot checklist (ADR 0004)

This is a public repository. Per [ADR 0004](adr/0004-real-deployment-values-in-a-local-file.md), never commit real AWS project details from `deployments.local.json` in screenshots, logs, or docs.

Before saving any screenshot or quoting output from `production-cdk` or `production-alchemy`, verify and redact:

| Private value | Where it can appear | Replace with |
| --- | --- | --- |
| 12-digit AWS account ID | `DlqSheet` SQS ARNs & CloudWatch log lines, `Stack` tab | `123456789012` |
| Real SES inbox domain | Monitor `Inbox` column subtitle (`SES · noreply@...`) | `example.com` |
| Real deployment prefix | `DlqSheet` header, `Handlers` / `Queues` / `Stack` tabs | `example-leads` |
| Sender email whitelist | Monitor `Runtime settings` tab | Do not screenshot on production |

### Recommended desktop viewports for clean, unclipped captures (`1440px` wide, light mode)

| View | Viewport | Scroll / setup |
| --- | --- | --- |
| Monitor: Pipeline + Live Requests | `1440 × 1390` (settled) or `1440 × 1495` (with metric-delay alert) | `y = 0`, `?hours=24` |
| Monitor: `RequestSheet` or `DlqSheet` | `1440 × 1050` | Wait for lazy CloudWatch Logs read |
| Simulator: Cost summary | `1440 × 780` | `y = 0`, default knobs |
| Simulator: Limit guardrails | `1440 × 960` | `y = 0`, e.g. `L = 200000`, `L_q_c = 250` |
| Simulator: 6-lane timeline (waves or comparison) | `1440 × 1570`–`1620` | Scroll to `Timeline of the handlers` panel; click a lane to seek cursor |
| Simulator: Comparison tables | `1440 × 1135` | Scroll to `y = 155` |
