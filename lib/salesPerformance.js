const { coqlQuery } = require('./zoho');
const { toDisplay, BUCKET, CANCELLED_STATUSES, NOT_CONFIRMED_STATUSES, SUPERCEDED_STATUSES } = require('./statusMap');

// Zoho COQL rejects BETWEEN on date/datetime columns (confirmed live,
// 2026-08-06: "invalid operator found"). Always use >= / <=.
function dtStart(dateStr) { return `${dateStr}T00:00:00+00:00`; }
function dtEnd(dateStr) { return `${dateStr}T23:59:59+00:00`; }

// Period bucketing helpers -------------------------------------------------

function periodKey(dateStr, granularity) {
  const d = new Date(dateStr);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-11
  if (granularity === 'year') return `${y}`;
  if (granularity === 'quarter') return `${y}-Q${Math.floor(m / 3) + 1}`;
  return `${y}-${String(m + 1).padStart(2, '0')}`; // month, default
}

function emptyPeriod() {
  return {
    projectsRegistered: 0,
    projectsRegisteredNY: 0,
    projectsRegisteredNJ: 0,
    quoteAmount: 0,
    quoteAmountNY: 0,
    quoteAmountNJ: 0,
    orderPOAmount: 0,
    orderPOCount: 0,
    shippedAmount: 0,
    shippedAmountNY: 0,
    shippedAmountNJ: 0,
    shippedCount: 0,
    shippedPlusESDAmount: 0,
    cancelledAmount: 0,
    cancelledCount: 0,
    notConfirmedAmount: 0,
    notConfirmedCount: 0,
    nyCredit: 0,
    njCredit: 0
  };
}

// Main aggregation ----------------------------------------------------------
// dateFrom / dateTo: ISO date strings, e.g. '2020-01-01' / '2026-12-31'
// granularity: 'month' | 'quarter' | 'year'
async function getSalesPerformance(dateFrom, dateTo, granularity = 'month') {
  const periods = {}; // periodKey -> emptyPeriod()

  function bucket(key) {
    if (!periods[key]) periods[key] = emptyPeriod();
    return periods[key];
  }

  // --- 1. Projects registered per period ---------------------------------
  // Adjust module/field name if your Project module's API name differs from "Deals"
  // Territory_Div confirmed live 2026-08-06 as a clean categorical NY/NJ
  // field on Deals (unlike Sales_Orders' fractional credit-split fields).
  const projectRows = await coqlQuery(
    `SELECT Created_Time, Territory_Div FROM Deals WHERE (Created_Time >= '${dtStart(dateFrom)}') AND (Created_Time <= '${dtEnd(dateTo)}')`
  );
  for (const row of projectRows) {
    const b = bucket(periodKey(row.Created_Time, granularity));
    b.projectsRegistered += 1;
    if (row.Territory_Div === 'NY Territory') b.projectsRegisteredNY += 1;
    else if (row.Territory_Div === 'NJ Territory') b.projectsRegisteredNJ += 1;
  }

  // --- 2. Quotation (latest) amount per period ----------------------------
  // Per Aug 2026 decision: use the Latest checkbox, ignore Quote_Status entirely
  // (Quote_Status is corrupted and conceptually overloaded - see notes in README).
  // NOTE: bucketed by `Quoted` (label "Quote Date"), NOT Created_Time.
  // Verified live 2026-08-06: some quotes show Quoted date up to ~2 months
  // before Created_Time - same CRM-entry-lag pattern as Sales_Orders.PO_Date,
  // initially missed because an early field search accidentally filtered out
  // any field name containing the substring "quote" (which "Quoted" matched).
  //
  // NOTE 2: Zoho COQL requires explicit parentheses once a query has 3+ AND
  // conditions, or it throws a bare "SYNTAX_ERROR near where" with no useful
  // detail. Confirmed live 2026-08-06 - always group conditions in pairs.
  //
  // NOTE 3 - IMPORTANT, confirmed intentional with Bosun 2026-08-06: this
  // metric answers "current pipeline value, grouped by when it originated,"
  // NOT "a permanent historical record of what was quoted." Because only
  // the current Latest=true revision of each quote-lineage counts, a past
  // month's total WILL change over time as old quotes get revised - e.g. a
  // quote-lineage quoted twice in March ($110K, $115K) that gets revised
  // again in May can drop March's total to near zero and show a small
  // number in May instead, even though the real work happened in March.
  // This is confirmed to be the intended behavior of the Latest flag, not
  // a bug. If a stable, non-drifting "historical quoting activity" metric
  // is ever needed alongside this one, it requires a DIFFERENT query - every
  // revision counted by its own Quoted date, ignoring Latest entirely - as
  // an additional metric, not a replacement for this one.
  const quoteRows = await coqlQuery(
    `SELECT Amount, Quoted, Territory_Div FROM Quotes WHERE (Latest = true) AND (Quoted >= '${dateFrom}' AND Quoted <= '${dateTo}')`
  );
  for (const row of quoteRows) {
    const b = bucket(periodKey(row.Quoted, granularity));
    const amount = Number(row.Amount || 0);
    b.quoteAmount += amount;
    if (row.Territory_Div === 'NY Territory') b.quoteAmountNY += amount;
    else if (row.Territory_Div === 'NJ Territory') b.quoteAmountNJ += amount;
  }

  // --- 3. Sales Orders: Order PO amount, Shipped, Cancelled, office credit -
  // NOTE: bucketed by PO_Date, NOT Created_Time. Verified 2026-08-06 against
  // a real NJ office report - Created_Time lags the actual customer PO date
  // by up to ~2 weeks (CRM data-entry lag), which silently shifted orders
  // into the wrong period. PO_Date is the real business event date.
  const soRows = await coqlQuery(
    `SELECT Quoted_Price, Status, NY_Office_Full_Credit, NJ_Office_Full_Credit, PO_Date, Ship_Date, Reference_no
     FROM Sales_Orders
     WHERE (PO_Date >= '${dateFrom}') AND (PO_Date <= '${dateTo}')`
  );

  for (const row of soRows) {
    const amount = Number(row.Quoted_Price || 0);
    const displayStatus = toDisplay(row.Status);
    const orderKey = periodKey(row.PO_Date, granularity);
    const b = bucket(orderKey);

    // Superceded: a replacement order already exists carrying this value.
    // Per Bosun's clarification (2026-08-06), exclude entirely - not even
    // counted as "lost" - counting it anywhere double-counts against its
    // replacement order.
    if (SUPERCEDED_STATUSES.includes(displayStatus)) {
      continue;
    }

    // Not yet confirmed (On Hold): excluded from Order PO amount, tracked
    // as its own pending bucket rather than lumped with cancellations.
    if (NOT_CONFIRMED_STATUSES.includes(displayStatus)) {
      b.notConfirmedAmount += amount;
      b.notConfirmedCount += 1;
      continue;
    }

    // Genuinely cancelled: real lost pipeline, excluded from Order PO amount.
    if (CANCELLED_STATUSES.includes(displayStatus)) {
      b.cancelledAmount += amount;
      b.cancelledCount += 1;
      continue;
    }

    // Everything remaining is confirmed (Order Registered / Ordered to
    // vendor / Ship Standby / Shipped) and counts toward Order PO amount.
    b.orderPOAmount += amount;
    b.orderPOCount += 1;
    b.nyCredit += Number(row.NY_Office_Full_Credit || 0);
    b.njCredit += Number(row.NJ_Office_Full_Credit || 0);

    if (displayStatus === BUCKET.SHIPPED) {
      // Shipped revenue is bucketed by Ship_Date, not PO date
      const shipKey = row.Ship_Date ? periodKey(row.Ship_Date, granularity) : orderKey;
      const shipBucket = bucket(shipKey);
      shipBucket.shippedAmount += amount;
      shipBucket.shippedAmountNY += Number(row.NY_Office_Full_Credit || 0);
      shipBucket.shippedAmountNJ += Number(row.NJ_Office_Full_Credit || 0);
      shipBucket.shippedCount += 1;
      shipBucket.shippedPlusESDAmount += amount;
    } else if (displayStatus === BUCKET.ORDERED_TO_VENDOR) {
      // "To be shipped" - included in Shipped+ESD but not yet in realized Shipped.
      // NOTE: this uses the PO-date period as a placeholder bucket. A more
      // accurate version pulls MAX(ETD) from linked Purchase_Orders via
      // Reference_no join - see README "Known simplifications".
      b.shippedPlusESDAmount += amount;
    }
  }

  // --- 4. Sort periods and compute conversion rates -----------------------
  const sortedKeys = Object.keys(periods).sort();
  const result = sortedKeys.map((key) => {
    const p = periods[key];
    return {
      period: key,
      ...p,
      combinedUS: p.orderPOAmount, // per Aug 2026 decision: independent SUM(Quoted_Price), not NY+NJ derived
      quoteToOrderConversion: p.quoteAmount > 0 ? p.orderPOAmount / p.quoteAmount : null,
      orderToShippedConversion: p.orderPOAmount > 0 ? p.shippedAmount / p.orderPOAmount : null
    };
  });

  return result;
}

module.exports = { getSalesPerformance, getQuoteSnapshotByPeriod, getBreakdownByAgencyAndAccount };

// ---------------------------------------------------------------------------
// Breakdown by Agency and Account, for a given date range ------------------
// ---------------------------------------------------------------------------
// Account_Name is a genuine CRM lookup - reliable grouping key.
// LocalAgency is free text, NOT a lookup. Confirmed with Bosun 2026-08-06:
// some values combine two agency codes in one field (e.g. "SLS, FED") -
// this is NOT a typo or data error. Before separate Local/Spec Agency
// fields existed, staff picked both into one multi-select field. Per
// Bosun: "do not worry too much about the past ... the point is to create
// a vessel that contains the quality data."
//
// Design choice: group by the raw string as-is, no splitting or
// normalization attempted. Clean single-agency values (the majority, and
// all new data going forward) get accurate totals automatically. Legacy
// combined values show up as their own honest bucket - visible for what
// they are, not silently discarded or fabricated into a false split. Also
// note: some codes here (KUS, LES, BOL, LSA, PLC, etc.) aren't in the
// Commission SOP's registered 12-agency list - KUS alone is ~1/3 of all
// records, clearly a legitimate internal/house code, so that reference
// list is understood to be incomplete rather than the data being wrong.
async function getBreakdownByAgencyAndAccount(dateFrom, dateTo) {
  const soRows = await coqlQuery(
    `SELECT Quoted_Price, Status, LocalAgency, Account_Name
     FROM Sales_Orders
     WHERE (PO_Date >= '${dateFrom}') AND (PO_Date <= '${dateTo}')`
  );

  const byAgency = new Map();
  const byAccount = new Map();

  for (const row of soRows) {
    const displayStatus = toDisplay(row.Status);
    // Same confirmed-orders-only rule as the main funnel: exclude
    // Superceded/On Hold/Cancelled from these totals.
    if (SUPERCEDED_STATUSES.includes(displayStatus)) continue;
    if (NOT_CONFIRMED_STATUSES.includes(displayStatus)) continue;
    if (CANCELLED_STATUSES.includes(displayStatus)) continue;

    const amount = Number(row.Quoted_Price || 0);

    const agencyKey = row.LocalAgency || '(blank)';
    if (!byAgency.has(agencyKey)) byAgency.set(agencyKey, { amount: 0, count: 0 });
    byAgency.get(agencyKey).amount += amount;
    byAgency.get(agencyKey).count += 1;

    const accountKey = (row.Account_Name && row.Account_Name.name) ? row.Account_Name.name : '(blank)';
    if (!byAccount.has(accountKey)) byAccount.set(accountKey, { amount: 0, count: 0 });
    byAccount.get(accountKey).amount += amount;
    byAccount.get(accountKey).count += 1;
  }

  const toSortedArray = (map) =>
    Array.from(map.entries())
      .map(([name, v]) => ({ name, amount: v.amount, count: v.count }))
      .sort((a, b) => b.amount - a.amount);

  return { byAgency: toSortedArray(byAgency), byAccount: toSortedArray(byAccount) };
}

// ---------------------------------------------------------------------------
// Quote pipeline snapshot, as of end of each period ------------------------
// ---------------------------------------------------------------------------
// Distinct from getSalesPerformance's quoteAmount, which uses today's
// Latest=true flag and DRIFTS over time (confirmed intentional with Bosun,
// 2026-08-06 - see NOTE 3 in getSalesPerformance).
//
// This metric answers a different question: "what was the latest revision
// of each quote-lineage AS OF THE END OF THIS PERIOD" - frozen permanently,
// never changes no matter when you re-run the report. Useful as a stable
// historical reference alongside the drifting live metric.
//
// Critical technical details, both confirmed live 2026-08-06 against real
// data (lineage QREF=8407-05):
//   1. Use Created_Time as the "as of" cutoff/ordering field, NEVER Quoted.
//      Quoted is a business-set date that can be backdated arbitrarily -
//      one real revision was Quoted "2026-03-30" but not actually entered
//      into the system (Created_Time) until 2026-07-20. Using Quoted as the
//      cutoff would have wrongly counted a July entry as if it existed in
//      March.
//   2. QREF (Project_Ref + SQN) is the lineage-grouping key, but is NOT
//      guaranteed unique - legacy "(Group N)" suffixed records can share a
//      QREF with an unrelated newer lineage, sometimes with both flagged
//      Latest=true simultaneously. Per Bosun (2026-08-06): this should not
//      happen and is rare when it does; Created_Time is the correct
//      tiebreaker (most recent Created_Time wins), same rule as normal
//      revision ordering. Not treated as a blocking data-quality issue.
async function getQuoteSnapshotByPeriod(dateFrom, dateTo, granularity = 'month') {
  // Pull every quote revision ever created up to the end of the requested
  // range - we need full lineage history to know what was "latest" at any
  // earlier cutoff, not just revisions dated within the range itself.
  const rows = await coqlQuery(
    `SELECT QREF, Created_Time, Amount FROM Quotes WHERE (Created_Time <= '${dtEnd(dateTo)}') AND (QREF is not null)`
  );

  // Sort ascending by Created_Time so we can sweep forward in true
  // chronological order and always know "what was latest as of right now"
  // at any point in the sweep.
  rows.sort((a, b) => new Date(a.Created_Time) - new Date(b.Created_Time));

  const periodEnds = buildPeriodEnds(dateFrom, dateTo, granularity);
  const latestByLineage = new Map(); // QREF -> Amount (most recent Created_Time wins)
  const result = [];
  let rowIdx = 0;

  for (const { key, endOfPeriod } of periodEnds) {
    // Advance the sweep to include every row created by this period's end
    while (rowIdx < rows.length && new Date(rows[rowIdx].Created_Time) <= endOfPeriod) {
      const row = rows[rowIdx];
      latestByLineage.set(row.QREF, Number(row.Amount || 0));
      rowIdx += 1;
    }
    const snapshotTotal = Array.from(latestByLineage.values()).reduce((a, v) => a + v, 0);
    result.push({ period: key, quoteSnapshotAsOfPeriod: snapshotTotal, lineageCount: latestByLineage.size });
  }

  return result;
}

function buildPeriodEnds(dateFrom, dateTo, granularity) {
  const periods = [];
  const start = new Date(dateFrom + 'T00:00:00Z');
  const end = new Date(dateTo + 'T23:59:59Z');
  let cursor = new Date(start);

  while (cursor <= end) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    let key, endOfPeriod;

    if (granularity === 'year') {
      key = `${y}`;
      endOfPeriod = new Date(Date.UTC(y, 11, 31, 23, 59, 59));
      cursor = new Date(Date.UTC(y + 1, 0, 1));
    } else if (granularity === 'quarter') {
      const q = Math.floor(m / 3);
      key = `${y}-Q${q + 1}`;
      endOfPeriod = new Date(Date.UTC(y, q * 3 + 3, 0, 23, 59, 59));
      cursor = new Date(Date.UTC(y, q * 3 + 3, 1));
    } else {
      key = `${y}-${String(m + 1).padStart(2, '0')}`;
      endOfPeriod = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59));
      cursor = new Date(Date.UTC(y, m + 1, 1));
    }
    periods.push({ key, endOfPeriod });
  }
  return periods;
}
