# Orders Dashboard

**Design record** (initially decided 18 Oct 2026; updated to reflect the current monorepo hexagon in [`apps/dashboard`](../../apps/dashboard)).  
**Source of truth:** [`apps/dashboard`](../../apps/dashboard) (Orders hexagon & UI) · [`OrderRepository/live.ts`](../../packages/pipeline/src/Infrastructure/Pipeline/OrderRepository/live.ts) (`storedAt` write).

---

## Problem

The lead handler stores every deduplicated lead as an **Order** in DynamoDB, keyed only by its content-derived `idempotencyKey`. Inspecting stored orders through the AWS Console or the **Lab** falls short for three reasons:

1. **No sorting or filtering in DynamoDB:** The table has only a partition key (`idempotencyKey`) and no sort key or index, so you cannot list newest orders first or filter by city or source type.
2. **Heterogeneous schemas:** The three workbook types (`new_acquisition`, `business_closure`, `mutation`) carry different columns.
3. **The Request ledger is not an Orders list:** The ledger counts processing attempts, not unique orders — re-uploading the same 15-row workbook 9 times shows `135` processed leads in the ledger, but only `15` deduplicated orders exist in the Orders table.

The **Lab** ([`apps/lab`](../../apps/lab)) is an internal observability workbench for queues, Lambda runs, DLQs, and AWS costs. Business users need a quiet, read-only view of the stored orders themselves.

---

## Architecture: an isolated, read-only hexagon

Following [ADR 0001](../adr/0001-one-hexagon-per-app.md) (*one hexagon per app*), the Orders dashboard is its own TanStack Start app ([`apps/dashboard`](../../apps/dashboard), default port `4790`) with its own `Core/Orders` hexagon — completely independent of `@leads/pipeline`:

- **CQRS read/write port split:** The dashboard defines a read-only [`OrderReader`](../../apps/dashboard/src/Core/Orders/Ports/OrderReader.ts) port (`all: Effect<OrderRead, OrdersNotRead>`), completely separate from `@leads/pipeline`'s write-only `OrderRepository`. Neither app gains permissions or methods belonging to the other.
- **Shared kernel & UI kit:** It reads only `@leads/shared` (lead schemas, deployment registry, resource names) and `@leads/ui` (shared shadcn/ui components and theme tokens in `@leads/ui/globals.css`), so its look stays locked in sync with the Lab.
- **Same deployment contract:** Selected via `DEPLOYMENT` and `AWS_PROFILE` (`pnpm dashboard`) or local Floci (`pnpm dashboard:local`), binding the table name from `resourceNames(deployment.prefix).ordersTable`.

---

## Key design decisions

### 1. Storage timestamp (`storedAt`)
- [`OrderRepository/live.ts`](../../packages/pipeline/src/Infrastructure/Pipeline/OrderRepository/live.ts) stamps each newly stored order with `storedAt` (an ISO-8601 string from Effect's `Clock`, making it deterministic in tests).
- Because the DynamoDB put is conditional (`attribute_not_exists(idempotencyKey)`), a resent workbook or redrive preserves the original item and its first `storedAt`.
- `storedAt` belongs to the stored Order only — the `Lead` domain type and SQS payload are unchanged. Legacy items stored without `storedAt` decode with `storedAt: undefined` (no backfill required).

### 2. Strict decoding & cause-preserving errors (`OrderReader`)
- [`OrderReader/live.ts`](../../apps/dashboard/src/Infrastructure/Orders/OrderReader/live.ts) scans all pages of the Orders table, decoding every item against the shared `Lead` schema and reading `storedAt` alongside it.
- Corrupt items are never silently dropped: a decoding failure fails the read with [`OrdersNotRead`](../../apps/dashboard/src/Core/Orders/Ports/OrderReader.ts) carrying the offending `key`, the original failure unchanged in `reason`, and an `authentication: boolean` flag so the UI can prompt the user to re-sign in when AWS credentials expire.
- Total order counts come from the actual scan, not DynamoDB `DescribeTable` (which refreshes only every ~6 hours).

### 3. One pure query pipeline (`orderPageOf`)
The [`ReadOrders`](../../apps/dashboard/src/Core/Orders/Application/UseCases/ReadOrders/handler.ts) use case simply loads `OrderReader.all` and delegates everything else to a single pure domain function (`orderPageOf`), making search, filtering, sorting, and pagination trivial to test without DynamoDB or a browser:

- **Flat row projection:** Projects all three source types into a uniform row (`name`, `street`, `zip`, `city`, `phone`, `mobile`, `email`, `uid`, `subjectNumber`, `companyAdditional`, `ownerName`, `sourceType`, `storedAt`, plus the original workbook columns in their original order for the detail sheet).
- **Search & type filter ([`orderFilter.ts`](../../apps/dashboard/src/Core/Orders/Domain/orderFilter.ts)):** Case-insensitive substring match across `name`, `street`, `city`, `zip`, `phone`, `mobile`, `email`, and `uid`, combined with a source-type filter (`all` or one of the 3 types). Per-type badge counts are computed *after* search and *before* the type filter so users see what each choice will yield.
- **Deterministic sorting ([`orderSort.ts`](../../apps/dashboard/src/Core/Orders/Domain/orderSort.ts)):** Sorts by `storedAt` (default newest first), `name`, `city`, `zip`, or `type`. Ties break deterministically on `idempotencyKey`, and orders missing a value sort to the end in *both* directions.
- **Safe pagination ([`orderPaging.ts`](../../apps/dashboard/src/Core/Orders/Domain/orderPaging.ts)):** Page sizes of `10`, `25` (default), or `50`. Changing `q`, `type`, `sort`, `dir`, or `size` resets `page` to `1`. Out-of-range page numbers clamp cleanly to `1` or the last page (an empty result still has 1 page).
- **Independent selected-order lookup:** When an `order` key is present in the query, it resolves against *all* stored orders — so applying a filter doesn't abruptly close an open detail sheet, and stale links display a clear "not found" message.

### 4. URL-as-state & short-TTL Effect cache
- **Shareable URL state ([`orderQuery.ts`](../../apps/dashboard/src/Core/Orders/Domain/orderQuery.ts), [`routes/index.tsx`](../../apps/dashboard/src/routes/index.tsx)):** The entire query (`q`, `type`, `sort`, `dir`, `page`, `size`, `order`) lives in validated URL search parameters, stripped when equal to defaults. Invalid parameters fall back to defaults, search input is debounced, and browser Back/Forward undoes query changes.
- **10-second `Ref` cache ([`cache.ts`](../../apps/dashboard/src/Infrastructure/Orders/OrderReader/cache.ts), [`services.server.ts`](../../apps/dashboard/src/Entrypoints/Dashboard/services.server.ts)):** A long-lived Effect `ManagedRuntime` wires `makeOrderCache(reader, '10 seconds')` backed by `Ref` + `Clock`, so sorting, paging, and opening sheets share one table scan. Failed reads are never cached, and clicking **Refresh** passes `fresh: true` to bypass the cache.

---

## Scope, security & scaling path

- **Local & loopback-only:** Orders contain business contact information, so the dashboard runs locally on loopback with no public deployment or login layer yet, reusing the developer's AWS profile.
- **Read-only by design:** No UI action or server function can edit, delete, or export orders.
- **Full-scan ceiling:** A full table scan works well up to ~10,000 orders. When the table grows beyond that, `storedAt` is already in place to back a GSI (fixed partition key + `storedAt` sort key) after a one-time backfill of any legacy items without `storedAt`.
- **Order-to-request linking:** Orders currently store no `requestID`; adding one in a future change would allow deep-linking straight from the Lab's `RequestSheet` to the orders produced by that email.
