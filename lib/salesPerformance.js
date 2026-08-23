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
    njCredit: 0,
    marginTotal: 0
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

  // --- 3. Sales Orders: Order PO amount, Shipped, Cancelled, office credit, margin -
  const soRows = await coqlQuery(
    `SELECT Quoted_Price, Status, NY_Office_Full_Credit, NJ_Office_Full_Credit, PO_Date, Ship_Date, Reference_no, Gen_Cost_TTL
     FROM Sales_Orders
     WHERE (PO_Date >= '${dateFrom}') AND (PO_Date <= '${dateTo}')`
  );

  for (const row of soRows) {
    const amount = Number(row.Quoted_Price || 0);
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

    b.orderPOAmount += amount;
    b.orderPOCount += 1;
    b.nyCredit += Number(row.NY_Office_Full_Credit || 0);
    b.njCredit += Number(row.NJ_Office_Full_Credit || 0);
    b.marginTotal += amount - Number(row.Gen_Cost_TTL || 0);

    if (displayStatus === BUCKET.SHIPPED) {
      const shipKey = row.Ship_Date ? periodKey(row.Ship_Date, granularity) : orderKey;
      const shipBucket = bucket(shipKey);
      shipBucket.shippedAmount += amount;
      shipBucket.shippedAmountNY += Number(row.NY_Office_Full_Credit || 0);
      shipBucket.shippedAmountNJ += Number(row.NJ_Office_Full_Credit || 0);
      shipBucket.shippedCount += 1;
      shipBucket.shippedPlusESDAmount += amount;
    } else if (displayStatus === BUCKET.ORDERED_TO_VENDOR) {
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
      combinedUS: p.orderPOAmount,
      quoteToOrderConversion: p.quoteAmount > 0 ? p.orderPOAmount / p.quoteAmount : null,
      orderToShippedConversion: p.orderPOAmount > 0 ? p.shippedAmount / p.orderPOAmount : null,
      marginPct: p.orderPOAmount > 0 ? (p.marginTotal / p.orderPOAmount) * 100 : null
    };
  });

  return result;
}

module.exports = { getSalesPerformance, getQuoteSnapshotByPeriod, getBreakdownByAgencyAndAccount };

// ---------------------------------------------------------------------------
// Breakdown by Agency and Account, for a given date range ------------------
// ---------------------------------------------------------------------------
async function getBreakdownByAgencyAndAccount(dateFrom, dateTo) {
  const soRows = await coqlQuery(
    `SELECT id, Quoted_Price, Status, LocalAgency, Account_Name
     FROM Sales_Orders
     WHERE (PO_Date >= '${dateFrom}') AND (PO_Date <= '${dateTo}')`
  );

  // Defensive dedupe by id
  const seen = new Set();
  const dedupedRows = [];
  for (const row of soRows) {
    if (row.id && seen.has(row.id)) continue;
    if (row.id) seen.add(row.id);
    dedupedRows.push(row);
  }

  const byAgency = new Map();
  const byAccount = new Map();

  for (const row of dedupedRows) {
    const displayStatus = toDisplay(row.Status);
    if (SUPERCEDED_STATUSES.includes(displayStatus)) continue;
    if (NOT_CONFIRMED_STATUSES.includes(displayStatus)) continue;
    if (CANCELLED_STATUSES.includes(displayStatus)) continue;

    const amount = Number(row.Quoted_Price || 0);

    const rawAgency = (row.LocalAgency || '').trim();
    const agencyKey = rawAgency.length > 0 ? rawAgency : '(blank)';
    if (!byAgency.has(agencyKey)) byAgency.set(agencyKey, { amount: 0, count: 0 });
    byAgency.get(agencyKey).amount += amount;
    byAgency.get(agencyKey).count += 1;

    const rawAccountName = row.Account_Name && typeof row.Account_Name === 'object' ? (row.Account_Name.name || '') : '';
    const accountKey = rawAccountName.trim().length > 0 ? rawAccountName.trim() : '(blank)';
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
