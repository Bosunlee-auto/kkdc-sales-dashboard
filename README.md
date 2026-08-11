# KKDC Sales Performance Dashboard

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
