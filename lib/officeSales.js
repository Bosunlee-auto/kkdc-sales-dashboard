// lib/officeSales.js
// NY Sales / NJ Sales / Total Sales dashboards. Sourced from Sales_Orders.
//
// Revenue field per dashboard (confirmed with Bosun, 2026-08-23):
//   - NY dashboard   -> NY_Office_Full_Credit  (Joint Territory orders already
//                       pre-split 50/50 into this field by the CRM formula)
//   - NJ dashboard   -> NJ_Office_Full_Credit
//   - Total dashboard-> Quoted_Price, summed INDEPENDENTLY (NOT
//                       NY_Office_Full_Credit + NJ_Office_Full_Credit). This
//                       matches the existing getSalesPerformance.js
//                       "combinedUS" decision from the 2026-08-06 session:
//                       Credit fields answer "whose money is this", Quoted_Price
//                       answers "how much did this order actually sell for" -
//                       they are not required to reconcile to the same total
//                       and a mismatch is a useful data-quality signal, not
//                       something to paper over.
//
// Overage (confirmed 2026-08-23): NOT included in Quoted_Price or either
// Full_Credit field - it is tracked entirely separately on Sales_Orders.
//   Overage_Payable = the agency's 80% share (already computed by CRM formula)
//   Company share   = Overage - Overage_Payable (KKDC's 20%)
// Sales_Orders has no per-office split field for Overage, so for the NY/NJ
// dashboards we attribute Overage proportionally to each office's share of
// Quoted_Price for that order (officeCredit / Quoted_Price). For Joint
// Territory orders this naturally lands close to 50/50, matching the Credit
// field split; for solo orders it's 100% to the one office. The Total
// dashboard always shows the full, unattributed Overage - no proportional
// math needed there.
//
// Margin = Quoted_Price - Gen_Cost_TTL (Cost of Goods, CRM formula field).
// For NY/NJ dashboards, margin is attributed using the same proportional
// office-share method as Overage, for the same reason (no office-split cost
// field exists).

const { coqlQuery } = require('./zoho');
const { toDisplay, BUCKET, CANCELLED_STATUSES, NOT_CONFIRMED_STATUSES, SUPERCEDED_STATUSES } = require('./statusMap');

function periodKey(dateStr, granularity) {
  const d = new Date(dateStr);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (granularity === 'year') return `${y}`;
  if (granularity === 'quarter') return `${y}-Q${Math.floor(m / 3) + 1}`;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

function emptyPeriod() {
  return {
    orderRevenue: 0,      // office-attributed (or independent total) revenue
    orderCount: 0,
    overageTotal: 0,      // office-attributed (or full) overage
    overageAgencyShare: 0,
    overageCompanyShare: 0,
    marginTotal: 0,       // office-attributed (or full) margin
    shippedRevenue: 0,
    shippedCount: 0
  };
}

/**
 * office: 'NY' | 'NJ' | 'TOTAL'
 */
async function getOfficeSalesPerformance(office, dateFrom, dateTo, granularity = 'month') {
  const periods = {};
  function bucket(key) {
    if (!periods[key]) periods[key] = emptyPeriod();
    return periods[key];
  }

  const rows = await coqlQuery(
    `SELECT Quoted_Price, Status, NY_Office_Full_Credit, NJ_Office_Full_Credit, Overage, ` +
      `Overage_Payable, Gen_Cost_TTL, PO_Date, Ship_Date ` +
      `FROM Sales_Orders WHERE (PO_Date >= '${dateFrom}') AND (PO_Date <= '${dateTo}')`
  );

  for (const row of rows) {
    const displayStatus = toDisplay(row.Status);
    if (SUPERCEDED_STATUSES.includes(displayStatus)) continue;
    if (NOT_CONFIRMED_STATUSES.includes(displayStatus)) continue;
    if (CANCELLED_STATUSES.includes(displayStatus)) continue;

    const quotedPrice = Number(row.Quoted_Price || 0);
    const nyCredit = Number(row.NY_Office_Full_Credit || 0);
    const njCredit = Number(row.NJ_Office_Full_Credit || 0);
    const overage = Number(row.Overage || 0);
    const overageAgency = Number(row.Overage_Payable || 0);
    const overageCompany = overage - overageAgency;
    const cost = Number(row.Gen_Cost_TTL || 0);
    const margin = quotedPrice - cost;

    // Office attribution share - proportional to that office's Full_Credit
    // relative to the order's total Quoted_Price. Solo orders -> 1.0 or 0.0.
    // Joint Territory orders -> ~0.5 each (matches the CRM's own 50/50 split).
    let officeShare = 1; // TOTAL dashboard: no attribution, use figures as-is
    let officeCredit = quotedPrice;
    if (office === 'NY') {
      officeCredit = nyCredit;
      officeShare = quotedPrice > 0 ? nyCredit / quotedPrice : 0;
    } else if (office === 'NJ') {
      officeCredit = njCredit;
      officeShare = quotedPrice > 0 ? njCredit / quotedPrice : 0;
    }
    if (office !== 'TOTAL' && officeShare === 0) continue; // order not this office's at all

    const b = bucket(periodKey(row.PO_Date, granularity));
    b.orderRevenue += office === 'TOTAL' ? quotedPrice : officeCredit;
    b.orderCount += 1;
    b.overageTotal += overage * officeShare;
    b.overageAgencyShare += overageAgency * officeShare;
    b.overageCompanyShare += overageCompany * officeShare;
    b.marginTotal += margin * officeShare;

    if (displayStatus === BUCKET.SHIPPED) {
      const shipKey = row.Ship_Date ? periodKey(row.Ship_Date, granularity) : periodKey(row.PO_Date, granularity);
      const sb = bucket(shipKey);
      sb.shippedRevenue += office === 'TOTAL' ? quotedPrice : officeCredit;
      sb.shippedCount += 1;
    }
  }

  const sortedKeys = Object.keys(periods).sort();
  return sortedKeys.map((key) => {
    const p = periods[key];
    return {
      period: key,
      ...round2All(p),
      marginPct: p.orderRevenue > 0 ? (p.marginTotal / p.orderRevenue) * 100 : null
    };
  });
}

function round2All(p) {
  const out = {};
  for (const k of Object.keys(p)) {
    out[k] = Math.round((p[k] + Number.EPSILON) * 100) / 100;
  }
  return out;
}

module.exports = { getOfficeSalesPerformance };
