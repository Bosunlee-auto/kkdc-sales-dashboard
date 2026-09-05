const { coqlQuery } = require('./zoho');
const { toDisplay, BUCKET, CANCELLED_STATUSES, NOT_CONFIRMED_STATUSES, SUPERCEDED_STATUSES } = require('./statusMap');

// House-account / internal Subject codes - confirmed live 2026-08-25 (Bosun):
// these are NOT real customer sales (mostly Account_Name = "KKDC Inc." -
// samples, internal transfers, etc.), and CRM's own native "Net Sales"
// reports explicitly exclude them (Subject doesn't contain 0100,0500,0900).
// Applied everywhere Sales_Orders revenue is summed, to match that
// definition and avoid inflating real sales performance with internal
// house-account movements. Subject is never null on Sales_Orders (confirmed
// live), so this exclusion doesn't need a null-safety fallback.
const HOUSE_ACCOUNT_SUBJECTS = ['0100', '0500', '0900'];
function subjectExclusionClause() {
  return HOUSE_ACCOUNT_SUBJECTS.map((s) => `'${s}'`).join(',');
}

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
    quoteCount: 0,
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
    njCredit: 0,
    marginTotal: 0,
    costTotal: 0
  };
}

// Main aggregation ----------------------------------------------------------
// dateFrom / dateTo: ISO date strings, e.g. '2020-01-01' / '2026-12-31'
// granularity: 'month' | 'quarter' | 'year'
// office: null (combined, default) | 'NY' | 'NJ' - scopes revenue/margin/
//   shipped/cancelled to that office, using the SAME field names as the
//   combined result so NY Sales / NJ Sales pages can reuse the exact same
//   frontend rendering code as Total Sales (2026-08-23, per Bosun: "Total
//   sales, NJ and NY sales should be all in the same format").
//
// Office scoping rules:
//   - Quote / Projects Registered: already tracked per-office via
//     Territory_Div on Quotes/Deals (quoteAmountNY/NJ, projectsRegisteredNY/
//     NJ) - just promoted to the primary field when office is set.
//   - Order PO / Shipped / Cancelled amount: uses the REAL
//     NY_Office_Full_Credit / NJ_Office_Full_Credit field directly (not a
//     proportional estimate) - Joint Territory orders are already split
//     50/50 into these fields by the CRM formula.
//   - Margin (GPM1) / Cost (COST_TTL): NO office-split field exists for
//     either, so when office-scoped these are attributed proportionally to
//     that office's share of the order (officeCredit / Quoted_Price) - same
//     method used in officeSales.js for the original NY/NJ dashboards.
//   - A row only counts toward an office-scoped view if that office's
//     credit is non-zero for the order (i.e. it's genuinely that office's
//     order, whether solo or a Joint Territory split).
async function getSalesPerformance(dateFrom, dateTo, granularity = 'month', office = null) {
  const periods = {}; // periodKey -> emptyPeriod()

  function bucket(key) {
    if (!periods[key]) periods[key] = emptyPeriod();
    return periods[key];
  }

  // --- 1. Projects registered per period ---------------------------------
  const projectRows = await coqlQuery(
    `SELECT Created_Time, Territory_Div FROM Deals WHERE (Created_Time >= '${dtStart(dateFrom)}') AND (Created_Time <= '${dtEnd(dateTo)}')`
  );
  for (const row of projectRows) {
    if (office === 'NY' && row.Territory_Div !== 'NY Territory') continue;
    if (office === 'NJ' && row.Territory_Div !== 'NJ Territory') continue;
    const b = bucket(periodKey(row.Created_Time, granularity));
    b.projectsRegistered += 1;
    if (row.Territory_Div === 'NY Territory') b.projectsRegisteredNY += 1;
    else if (row.Territory_Div === 'NJ Territory') b.projectsRegisteredNJ += 1;
  }

  // --- 2. Quotation (latest) amount per period ----------------------------
  const quoteRows = await coqlQuery(
    `SELECT Amount, Quoted, Territory_Div FROM Quotes WHERE (Latest = true) AND (Quoted >= '${dateFrom}' AND Quoted <= '${dateTo}')`
  );
  for (const row of quoteRows) {
    if (office === 'NY' && row.Territory_Div !== 'NY Territory') continue;
    if (office === 'NJ' && row.Territory_Div !== 'NJ Territory') continue;
    const b = bucket(periodKey(row.Quoted, granularity));
    const amount = Number(row.Amount || 0);
    b.quoteAmount += amount;
    b.quoteCount += 1;
    if (row.Territory_Div === 'NY Territory') b.quoteAmountNY += amount;
    else if (row.Territory_Div === 'NJ Territory') b.quoteAmountNJ += amount;
  }

  // --- 3. Sales Orders: Order PO amount, Cancelled, office credit, margin --
  // NOTE: bucketed by PO_Date, NOT Created_Time. Verified 2026-08-06 against
  // a real NJ office report - Created_Time lags the actual customer PO date
  // by up to ~2 weeks (CRM data-entry lag), which silently shifted orders
  // into the wrong period. PO_Date is the real business event date.
  //
  // Margin (2026-08-23, corrected): use CRM's own GPM1 field (dollar gross
  // margin) directly instead of recomputing Quoted_Price - Gen_Cost_TTL.
  // Per Bosun: margin is already calculated per-order in CRM (visible on the
  // record detail as "10. SALES SUMMARY - GPM / GPM %") and is more reliable
  // than a manual recompute - GPM1's revenue basis is NOT the same as
  // Quoted_Price (confirmed live: GPM1 + COST_TTL != Quoted_Price for the
  // same record), so summing GPM1 directly (rather than deriving it) avoids
  // silently using the wrong revenue denominator.
  //
  // IMPORTANT (2026-08-24 bug fix): Shipped/Net Sales figures were REMOVED
  // from this PO_Date-filtered loop and moved to their own Ship_Date-filtered
  // query below. Root cause found by comparing against the native Zoho CRM
  // "Yearly Net Sales" widgets: many orders are PO'd in one year and shipped
  // in the next (confirmed live - e.g. PO_Date 2025-11-17 / Ship_Date
  // 2026-06-16, $12,326.95 NY credit). Filtering Sales_Orders by PO_Date
  // silently excluded that order's shipped revenue from 2026 entirely, even
  // though it genuinely shipped in 2026 - this made our Shipped/Net Sales
  // totals understate the CRM-native dashboards' numbers. Order PO Amount
  // (bookings) is correctly PO_Date-driven and unaffected by this fix.
  const soRows = await coqlQuery(
    `SELECT id, Quoted_Price, Status, NY_Office_Full_Credit, NJ_Office_Full_Credit, PO_Date, Ship_Date, Reference_no, GPM1, COST_TTL
     FROM Sales_Orders
     WHERE (PO_Date >= '${dateFrom}') AND (PO_Date <= '${dateTo}' AND Subject not in (${subjectExclusionClause()}))`
  );

  // Defensive dedupe by id - same safeguard already used in
  // getBreakdownByAgencyAndAccount, added here too on cross-check
  // (2026-08-25) in case coqlQuery's LIMIT-based pagination ever returns
  // an overlapping row across pages. No duplication has been observed in
  // practice, but summing a duplicated row would silently inflate every
  // total in this function, so it's cheap insurance.
  const seenSoIds = new Set();

  for (const row of soRows) {
    if (row.id) {
      if (seenSoIds.has(row.id)) continue;
      seenSoIds.add(row.id);
    }

    const quotedPrice = Number(row.Quoted_Price || 0);
    const nyCredit = Number(row.NY_Office_Full_Credit || 0);
    const njCredit = Number(row.NJ_Office_Full_Credit || 0);

    // Office-scoped amount uses the real credit field directly; combined
    // view uses Quoted_Price (independent sum - see module-level notes).
    let amount = quotedPrice;
    let officeShare = 1; // for margin/cost attribution; 1 = no attribution (combined view)
    if (office === 'NY') {
      amount = nyCredit;
      officeShare = quotedPrice > 0 ? nyCredit / quotedPrice : 0;
      if (officeShare === 0) continue; // not an NY order at all
    } else if (office === 'NJ') {
      amount = njCredit;
      officeShare = quotedPrice > 0 ? njCredit / quotedPrice : 0;
      if (officeShare === 0) continue; // not an NJ order at all
    }

    const displayStatus = toDisplay(row.Status);
    const orderKey = periodKey(row.PO_Date, granularity);
    const b = bucket(orderKey);

    if (SUPERCEDED_STATUSES.includes(displayStatus)) {
      continue;
    }

    if (NOT_CONFIRMED_STATUSES.includes(displayStatus)) {
      b.notConfirmedAmount += amount;
      b.notConfirmedCount += 1;
      continue;
    }

    if (CANCELLED_STATUSES.includes(displayStatus)) {
      b.cancelledAmount += amount;
      b.cancelledCount += 1;
      continue;
    }

    // Everything remaining is confirmed (Order Registered / Ordered to
    // vendor / Ship Standby / Shipped) and counts toward Order PO amount.
    b.orderPOAmount += amount;
    b.orderPOCount += 1;
    b.nyCredit += nyCredit;
    b.njCredit += njCredit;
    b.marginTotal += Number(row.GPM1 || 0) * officeShare;
    b.costTotal += Number(row.COST_TTL || 0) * officeShare;
  }

  // --- 3a. Shipped + ESD - unified single query by Ship_Date ---------------
  // SIMPLIFIED 2026-08-25 per Bosun, after directly comparing against the
  // CRM-native "Yearly Net Sales... SHIPPED_ESD Inclusive" report (Edit
  // Chart screenshot, confirmed live): that report does NOT separately
  // handle "shipped" vs "not yet shipped" - it runs ONE query grouped by
  // Ship_Date, filtered only to exclude Superceded / Order On Hold / Order
  // Cancelled (Shipped is NOT excluded - it's included in the same Ship_Date
  // grouping). Sales_Orders.Ship_Date auto-populates from each order's
  // line-item subform as "the latest ESD" regardless of whether that date
  // is past, present, or future, and needs no Purchase_Order lookup to be
  // meaningful - an earlier, more complex version of this code looked up
  // Purchase_Orders.ETD via the OUS_Ref link, which was found to diverge
  // from both Sales_Orders.Ship_Date and this CRM-native report, and has
  // been removed.
  //
  // House-account Subject codes (0100/0500/0900) are excluded here too -
  // confirmed live these are internal (mostly Account_Name = "KKDC Inc.")
  // movements, not real customer sales, matching the CRM-native report's
  // own "Subject doesn't contain 0100,0500,0900" filter.
  //
  // Upper bound is Dec 31 of dateTo's year, NOT dateTo itself - but ONLY
  // when dateTo's year is the real, current calendar year. That's the one
  // case where "forthcoming ESD through Dec 31" is a genuine forecast
  // extension (nothing can have SHIPPED in the future yet, so it only adds
  // pending/forecasted rows, never fabricates real shipments).
  //
  // BUG FIX (2026-09-05, found by comparing an in-progress-year YoY call
  // against the CRM-native "Yearly ... vs Last Year" widgets): the old code
  // assumed "for a past-year query, dateTo already = that year's Dec 31" -
  // true when viewing a past year on its own, but FALSE for the "prior"
  // side of a YoY comparison against an in-progress current year (e.g.
  // current = 2026-01-01..2026-09-04, prior = 2025-01-01..2025-09-04).
  // There, dateTo's year (2025) is a completed past year, so the old code
  // still stretched esdCutoff to 2025-12-31 - silently pulling in real
  // Oct-Dec 2025 shipments that happened AFTER the matched Sep-4 cutoff.
  // That inflated the prior-year total (full year ~$2.69M) far past the
  // true like-for-like figure (Jan1-Sep4 ~$1.57M, which matches the CRM-
  // native "Last Year Relative" exactly), making a genuine +18-19% YoY
  // increase look like a ~-27% decrease.
  const nowYear = new Date().getUTCFullYear();
  const dateToYear = new Date(dateTo).getUTCFullYear();
  const esdCutoff = dateToYear === nowYear ? `${dateToYear}-12-31` : dateTo;
  const shippedRows = await coqlQuery(
    `SELECT id, Quoted_Price, Status, NY_Office_Full_Credit, NJ_Office_Full_Credit, Ship_Date
     FROM Sales_Orders
     WHERE ((((Ship_Date >= '${dateFrom}') AND (Ship_Date <= '${esdCutoff}'))
       AND (Status not in ('${SUPERCEDED_STATUSES[0]}','${NOT_CONFIRMED_STATUSES[0]}','${CANCELLED_STATUSES[0]}')))
       AND (Subject not in (${subjectExclusionClause()})))`
  );

  const seenShippedIds = new Set(); // separate from seenSoIds above - this is a different query/date filter

  for (const row of shippedRows) {
    if (row.id) {
      if (seenShippedIds.has(row.id)) continue;
      seenShippedIds.add(row.id);
    }

    const quotedPrice = Number(row.Quoted_Price || 0);
    const nyCredit = Number(row.NY_Office_Full_Credit || 0);
    const njCredit = Number(row.NJ_Office_Full_Credit || 0);

    let amount = quotedPrice;
    if (office === 'NY') {
      amount = nyCredit;
      if (quotedPrice > 0 ? nyCredit / quotedPrice === 0 : true) continue;
    } else if (office === 'NJ') {
      amount = njCredit;
      if (quotedPrice > 0 ? njCredit / quotedPrice === 0 : true) continue;
    }

    // Every non-excluded row counts toward Shipped+ESD, whether it has
    // actually shipped yet or not - this IS the unified metric.
    const shipBucket = bucket(periodKey(row.Ship_Date, granularity));
    shipBucket.shippedPlusESDAmount += amount;

    // Only genuinely Shipped rows also count toward the separate
    // "realized" Shipped figure.
    const displayStatus = toDisplay(row.Status);
    if (displayStatus === BUCKET.SHIPPED) {
      shipBucket.shippedAmount += amount;
      shipBucket.shippedAmountNY += nyCredit;
      shipBucket.shippedAmountNJ += njCredit;
      shipBucket.shippedCount += 1;
    }
  }


  // --- 4. Sort periods and compute conversion rates -----------------------
  const sortedKeys = Object.keys(periods).sort();
  const result = sortedKeys.map((key) => {
    const p = periods[key];
    return {
      period: key,
      ...p,
      combinedUS: p.orderPOAmount,
      quoteToOrderConversion: p.quoteAmount > 0 ? p.orderPOAmount / p.quoteAmount : null,
      orderToShippedConversion: p.orderPOAmount > 0 ? p.shippedAmount / p.orderPOAmount : null,
      marginPct: (p.marginTotal + p.costTotal) > 0 ? (p.marginTotal / (p.marginTotal + p.costTotal)) * 100 : null
    };
  });

  return result;
}

module.exports = { getSalesPerformance, getQuoteSnapshotByPeriod, getBreakdownByAgencyAndAccount };

// ---------------------------------------------------------------------------
// Breakdown by Agency, Account (Specifier), and Customer, for a date range -
// ---------------------------------------------------------------------------
// Account_Name and Customer are both genuine CRM lookup fields on
// Sales_Orders, both pointing into the Accounts module (Account_Name =
// Specifier/Designer per KKDC ontology, Customer = the actual purchasing
// distributor/wholesaler). LocalAgency is free text, NOT a lookup.
//
// ROOT CAUSE FOUND 2026-08-23 (after extensive live debugging): when this
// app's own Zoho OAuth client runs a COQL query that selects a lookup field
// like Account_Name or Customer, the result comes back as { id } ONLY - the
// embedded "name" property Zoho normally includes for lookup fields is
// missing for THIS app's specific OAuth token, even though the exact same
// query returns { id, name } through a different authenticated client
// (verified live via a debug marker + raw sample in the API response).
// Dot-notation "Account_Name.name" in SELECT is also not supported by this
// org's COQL at all (tested live - INVALID_QUERY).
//
// FIX: don't rely on the embedded name for either field. Collect the
// distinct ids from Sales_Orders, then batch-resolve names directly from the
// Accounts module (its own name field is confusingly also called
// "Account_Name", but there it's a plain text field, not a nested lookup
// object) via "id in (...)" COQL queries, chunked to stay well under COQL's
// practical query-length limits. Same fix, same root cause, applied to both
// fields since they reference the same module.
async function getBreakdownByAgencyAndAccount(dateFrom, dateTo, office = null) {
  const soRows = await coqlQuery(
    `SELECT id, Quoted_Price, Status, LocalAgency, Account_Name, Customer, NY_Office_Full_Credit, NJ_Office_Full_Credit
     FROM Sales_Orders
     WHERE (PO_Date >= '${dateFrom}') AND (PO_Date <= '${dateTo}' AND Subject not in (${subjectExclusionClause()}))`
  );

  // Defensive dedupe by id, filter to confirmed-only rows, and (if office
  // scoped) filter to only that office's orders - same rule as
  // getSalesPerformance: an order counts for NY/NJ only if that office's
  // Full_Credit is non-zero. Amount used downstream is that office's
  // credit field directly, not Quoted_Price, when office-scoped.
  const seen = new Set();
  const confirmedRows = [];
  for (const row of soRows) {
    if (row.id && seen.has(row.id)) continue;
    if (row.id) seen.add(row.id);

    const displayStatus = toDisplay(row.Status);
    if (SUPERCEDED_STATUSES.includes(displayStatus)) continue;
    if (NOT_CONFIRMED_STATUSES.includes(displayStatus)) continue;
    if (CANCELLED_STATUSES.includes(displayStatus)) continue;

    if (office === 'NY' && !(Number(row.NY_Office_Full_Credit) > 0)) continue;
    if (office === 'NJ' && !(Number(row.NJ_Office_Full_Credit) > 0)) continue;

    confirmedRows.push(row);
  }

  // Resolve both Account and Customer names by id from the Accounts module,
  // since the embedded lookup name is unreliable for this app's OAuth
  // client (see note above). Both fields point into the same module, so we
  // resolve them together in one combined id set/batch pass.
  //
  // Performance note (2026-08-23): a wide default date range (e.g. all of
  // 2020-2026) can produce 1000+ distinct ids. Running the chunked "id in
  // (...)" lookups SERIALLY caused the whole endpoint to time out - By
  // Agency came back empty too even though it doesn't need any lookup
  // resolution, because the entire request failed before responding.
  // Fixed by running all chunk requests in parallel via Promise.all.
  const idsToResolve = new Set();
  for (const row of confirmedRows) {
    if (row.Account_Name && row.Account_Name.id) idsToResolve.add(row.Account_Name.id);
    if (row.Customer && row.Customer.id) idsToResolve.add(row.Customer.id);
  }
  const allIds = [...idsToResolve];
  const nameById = {};
  // Zoho COQL's "id in (...)" clause caps at 50 values per query (confirmed
  // live 2026-08-23: LIMIT_EXCEEDED, "value limit exceeded", limit: 50) -
  // NOT the more commonly assumed 100/200. Chunking at 150 caused every
  // single breakdown request to 500 until this was found.
  const CHUNK = 50;
  const chunkPromises = [];
  for (let i = 0; i < allIds.length; i += CHUNK) {
    const chunk = allIds.slice(i, i + CHUNK);
    const idList = chunk.map((id) => `'${id}'`).join(',');
    chunkPromises.push(coqlQuery(`SELECT id, Account_Name FROM Accounts WHERE id in (${idList})`));
  }
  const chunkResults = await Promise.all(chunkPromises);
  for (const acctRows of chunkResults) {
    for (const a of acctRows) {
      nameById[a.id] = a.Account_Name || '';
    }
  }

  const byAgency = new Map();
  const byAccount = new Map();
  const byCustomer = new Map();

  const addTo = (map, key, amount) => {
    if (!map.has(key)) map.set(key, { amount: 0, count: 0 });
    map.get(key).amount += amount;
    map.get(key).count += 1;
  };

  for (const row of confirmedRows) {
    const amount = office === 'NY' ? Number(row.NY_Office_Full_Credit || 0)
      : office === 'NJ' ? Number(row.NJ_Office_Full_Credit || 0)
      : Number(row.Quoted_Price || 0);

    const rawAgency = (row.LocalAgency || '').trim();
    addTo(byAgency, rawAgency.length > 0 ? rawAgency : '(blank)', amount);

    const acctId = row.Account_Name && row.Account_Name.id;
    const acctName = acctId ? (nameById[acctId] || '') : '';
    addTo(byAccount, acctName.trim().length > 0 ? acctName.trim() : '(blank)', amount);

    const custId = row.Customer && row.Customer.id;
    const custName = custId ? (nameById[custId] || '') : '';
    addTo(byCustomer, custName.trim().length > 0 ? custName.trim() : '(blank)', amount);
  }

  const toSortedArray = (map) =>
    Array.from(map.entries())
      .map(([name, v]) => ({ name, amount: v.amount, count: v.count }))
      .sort((a, b) => b.amount - a.amount);

  return {
    byAgency: toSortedArray(byAgency),
    byAccount: toSortedArray(byAccount),
    byCustomer: toSortedArray(byCustomer)
  };
}

// ---------------------------------------------------------------------------
// Quote pipeline snapshot, as of end of each period ------------------------
// ---------------------------------------------------------------------------
async function getQuoteSnapshotByPeriod(dateFrom, dateTo, granularity = 'month') {
  const rows = await coqlQuery(
    `SELECT QREF, Created_Time, Amount FROM Quotes WHERE (Created_Time <= '${dtEnd(dateTo)}') AND (QREF is not null)`
  );

  rows.sort((a, b) => new Date(a.Created_Time) - new Date(b.Created_Time));

  const periodEnds = buildPeriodEnds(dateFrom, dateTo, granularity);
  const latestByLineage = new Map();
  const result = [];
  let rowIdx = 0;

  for (const { key, endOfPeriod } of periodEnds) {
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
