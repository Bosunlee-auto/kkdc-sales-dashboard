# KKDC Sales Performance Dashboard

## 2026-08-23 update — 4 dashboards + login + margin/overage/tariff

Added on top of the existing Phase 1+1.5 funnel dashboard (which is now the
"Total Sales" page at `/index.html`):

- **`/ny-sales.html`** and **`/nj-sales.html`** — office-level revenue using
  `NY_Office_Full_Credit` / `NJ_Office_Full_Credit` (Sales_Orders). Overage
  and margin are attributed proportionally to each office's share of
  Quoted_Price (no per-office split field exists for either on Sales_Orders).
- **`/total-invoice.html`** — the only dashboard using the full invoiced
  `Amount` (freight/tariff/S&H included) instead of net product value. Margin
  = Net_Product_Value1 − Cost of Goods (joined from the linked Sales_Order) −
  Freight − Tariff (see schedule below).
- **Login** (`/login.html`) — session-based, backed by a new CRM custom
  module `Dashboard_Access` (fields: `Name` as login ID, `PIN_Code`,
  `Allowed_Dashboards` comma-text of `NY,NJ,TOTAL_SALES,TOTAL_INVOICE`,
  `Active`). Bosun manages users entirely in CRM UI — no redeploy needed to
  add/remove someone or change what they can see. `lib/dashboardAccess.js`
  caches the user list 2 minutes to avoid hammering Zoho on every login.

### Overage (confirmed 2026-08-23)
Overage is **not** included in `Quoted_Price`, `NY_Office_Full_Credit`, or
`NJ_Office_Full_Credit` — verified live against real Sales_Orders records
(Full_Credit == Quoted_Price exactly on solo orders with nonzero Overage).
It's tracked as its own field and split 80/20:
- `Overage_Payable` (Sales_Orders) = agency's 80% share
- Company's 20% share = `Overage - Overage_Payable` (no dedicated field on
  Sales_Orders)
- Invoices module has ready-made formula fields for the same split:
  `Overage_Agency_Share` / `Overage_Company_Share` — used directly for the
  Total Invoice dashboard, no manual math needed there.

### Tariff schedule (Total Invoice dashboard only)
Rate applied to `Net_Product_Value1`, keyed by **Ship_Date** (not Invoice
Date — confirmed explicitly with Bosun):

| Window | Formula | Effective rate |
|---|---|---|
| 2025-04-01 – 2025-07-31 | Net Product Value × 0.5 × 0.10 | 5.0% |
| 2025-08-01 – 2026-03-31 | Net Product Value × 0.5 × 0.189 | 9.45% |
| 2026-04-01 – present | Net Product Value × 0.5 × 0.10 | 5.0% |

Invoices with a Ship_Date before 2025-04-01, or with no linked Sales_Order
(`Invoices.Sales_Order` lookup is null on some older records), are excluded
from margin totals and surfaced as "Margin excluded" in the UI rather than
estimated with a guess.

### Known CRM data quirks hit while building this
- `Sales_Orders.Status` field-metadata picklist (via `getFields`) returned
  stale/wrong values (`Ready to ship`, `Cancelled_1`, etc.) that don't match
  what's actually stored in records. Always verify against live COQL
  (`select distinct Status from Sales_Orders where Status is not null`)
  rather than trusting field metadata for picklists on this module.
- COQL does not support `SUM(...)` with `GROUP BY` in this org (tested
  2026-08-23, same conclusion as the original Phase 1 build) — all
  aggregation in the new modules is done in JS after raw-row COQL, same
  pattern as `salesPerformance.js`.



Phase 1 + 1.5 build: funnel (Project → Quote → Order → Shipped), office split (NY/NJ),
conversion rates, cancelled/lost pipeline line, YoY comparison.

## Setup

```
npm install
cp .env.example .env
# fill in .env with real values, see below
npm start
```

## Environment variables (set in Railway's Raw Editor, not the standard UI —
## per the known issue in the NJ Inventory Portal deployment notes)

```
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
ZOHO_REFRESH_TOKEN=...
PORT=3000
```

Verify via `GET /api/debug` after deploy (masked values only, matches the
NJ Inventory Portal pattern).

## Deploying

1. Push this folder to a new GitHub repo (or a new Railway service in an
   existing project).
2. Connect Railway to the repo.
3. Set env vars via Railway's Raw Editor.
4. Once live, add as a Zoho CRM Web Tab pointing at the Railway URL.

## What this build assumes — please confirm before trusting the numbers

These were the explicit decisions from the Aug 2026 dashboard-scoping
session. If any of these change, the corresponding code needs to change too:

1. **Sales_Orders.Status is display/actual-value corrupted.** Handled via
   `lib/statusMap.js`. Do not touch the CRM's actual_value strings without
   updating this file to match, and do not trust any other code that reads
   `Status` without going through `toDisplay()`.

2. **Quote amount uses `Latest = true`, ignoring `Quote_Status` entirely.**
   `Quote_Status` is both display/actual corrupted AND conceptually mixes
   quote-stage and order-stage language — it was flagged as unusable for
   this purpose. If Quote_Status gets cleaned up later, this may become a
   more precise filter, but for now `Latest` is the field of record.

3. **Combined US = independent `SUM(Quoted_Price)`,** not derived from
   `NY_Office_Full_Credit + NJ_Office_Full_Credit`. This is deliberate —
   per Bosun's decision, Combined US should be able to reveal a mismatch
   between the two office-credit sums and the order's own amount, rather
   than silently reconstructing one from the other.

4. **"Ordered to vendor" (ESD-set-not-shipped) is bucketed by the
   order-placed period, not by projected ship date.** A more accurate
   version would join to `Purchase_Orders` (via `Reference_no` / `OUS_Ref`)
   and use `MAX(ETD)` per order. This was deferred as a Phase 2 refinement
   — the current version is directionally correct but not date-precise for
   this one bucket.

5. **Cancelled/lost line includes all four exception statuses** (`Order On
   Hold`, `Order Cancelled`, `Ship Standby`, `Superceded`) as one combined
   number. If you want them split apart (e.g. cancelled vs. on-hold shown
   separately), that's a small change to `salesPerformance.js`.

6. **Project module API name assumed to be `Deals`.** Zoho's default
   Projects/Opportunities module is API-named `Deals` unless renamed. If
   your Project module has a different API name, update the query in
   `salesPerformance.js` step 1.

## Not yet built (deferred per the phased plan)

- Agency/territory performance — needs a data-quality audit of the
  `LocalAgency`/`SpecAgency` free-text fields on Sales_Orders before it's
  safe to build a breakdown on top of them (same risk pattern as Status).
- Backlog snapshot (point-in-time open pipeline value) and cycle-time
  metrics — structurally different query pattern (point-in-time /
  date-delta vs. period-flow), scoped as Phase 3.
- Project Status rollup (Open / Dormant / Closed / Needs review) — logic
  is fully specified (8-month recency window, RMA-priority override) but
  needs a Deluge function built and wired to Quote/Order/RMA triggers.
  Not part of this dashboard's codebase; lives in CRM itself.
