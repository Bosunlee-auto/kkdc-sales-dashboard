// lib/invoiceDashboard.js
// Total Invoice dashboard. Sourced from Invoices - this is the ONLY one of the
// 4 dashboards that uses the full invoiced amount (freight/duty/S&H included),
// per Bosun (2026-08-23): "Only net product sales figures matter" for the
// Sales dashboards, but the Invoice dashboard exists specifically to show the
// real, total invoiced dollar figure.
//
// Margin here is the most involved calculation of the 4 dashboards:
//   Margin = Net_Product_Value1
//            - Gen_Cost_TTL      (Cost of Goods, from the LINKED Sales_Order)
//            - Freight           (SO.Freight_Amount_Domestic + SO.Post_Factory_Freight)
//            - Tariff            (computed - see schedule below)
//
// Cost and Freight live on Sales_Orders, not Invoices, so we join via the
// Invoices.Sales_Order lookup field (confirmed live 2026-08-23: some older
// invoices have a null Sales_Order lookup - those are margin-excluded and
// flagged in the result rather than silently guessed at).
//
// Tariff schedule (confirmed with Bosun 2026-08-23, based on actual duty
// paid): rate is applied to Net_Product_Value1, keyed by Ship_Date (NOT
// Invoice_Date - confirmed explicitly).
//   2025-04-01 to 2025-07-31          : Net_Product_Value1 * 0.5 * 0.10   (5.0%)
//   2025-08-01 to 2026-03-31          : Net_Product_Value1 * 0.5 * 0.189  (9.45%)
//   2026-04-01 to present             : Net_Product_Value1 * 0.5 * 0.10   (5.0%)
// Invoices with a Ship_Date outside all three windows (i.e. before
// 2025-04-01) get no tariff applied - the schedule doesn't reach back that far.

const { coqlQuery } = require('./zoho');

const TARIFF_SCHEDULE = [
  { from: '2025-04-01', to: '2025-07-31', rate: 0.5 * 0.10 },
  { from: '2025-08-01', to: '2026-03-31', rate: 0.5 * 0.189 },
  { from: '2026-04-01', to: '9999-12-31', rate: 0.5 * 0.10 }
];

function tariffRateFor(shipDateStr) {
  if (!shipDateStr) return null;
  const d = shipDateStr.slice(0, 10); // YYYY-MM-DD
  for (const window of TARIFF_SCHEDULE) {
    if (d >= window.from && d <= window.to) return window.rate;
  }
  return null; // outside schedule - no tariff data for this period
}

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
    invoiceTotal: 0,        // Amount - full invoiced value, freight/duty/S&H included
    invoiceTotalNY: 0,
    invoiceTotalNJ: 0,
    invoiceCount: 0,
    // Three-way split confirmed with Bosun (2026-08-25): "Invoice Total" is
    // the real, QuickBooks-booked revenue figure - and it needs to be split
    // into what's actually shipped/recognized vs. forward-looking vs. still
    // in Proforma (pre-shipment) status.
    //   1. Shipped (Recognized)   - Invoice_Category='Invoice' AND linked SO
    //                               Status='Shipped'. This is the real,
    //                               QBO-recognized revenue figure.
    //   2. Shipped+ESD (Forecast) - all Invoice_Category='Invoice' rows
    //                               (Status not yet Shipped too, using
    //                               Ship_Date as the ESD, same pattern as
    //                               the Sales Performance dashboards).
    //                               A superset of #1.
    //   3. Proforma Pending (Unbilled AR) - Invoice_Category='Proforma' -
    //                               money already invoiced/requested from
    //                               the customer ahead of shipment, not yet
    //                               converted to a real Invoice. Tracked
    //                               entirely separately, not blended into #2.
    invoiceShippedTotal: 0,
    invoiceShippedTotalNY: 0,
    invoiceShippedTotalNJ: 0,
    invoiceShippedESDTotal: 0,
    invoiceShippedESDTotalNY: 0,
    invoiceShippedESDTotalNJ: 0,
    invoiceProformaPendingTotal: 0,
    invoiceProformaPendingTotalNY: 0,
    invoiceProformaPendingTotalNJ: 0,
    netProductValue: 0,     // Net_Product_Value1, subtotal before freight/duty/S&H
    netProductValueNY: 0,
    netProductValueNJ: 0,
    overageAgencyShare: 0,
    overageCompanyShare: 0,
    costOfGoods: 0,
    freightTotal: 0,
    tariffTotal: 0,
    marginTotal: 0,
    marginTotalNY: 0,
    marginTotalNJ: 0,
    marginExcludedCount: 0, // invoices with no linked Sales_Order or no tariff-schedule match
    marginExcludedValue: 0
  };
}

function normalizeOffice(officeDiv) {
  if (!officeDiv) return null;
  const v = String(officeDiv).toLowerCase();
  if (v.includes('nj')) return 'NJ';
  if (v.includes('ny')) return 'NY';
  return null;
}

async function getInvoiceDashboard(dateFrom, dateTo, granularity = 'month') {
  const periods = {};
  function bucket(key) {
    if (!periods[key]) periods[key] = emptyPeriod();
    return periods[key];
  }

  // Upper bound extended to Dec 31 of dateTo's year - matching the same
  // fix applied to the Sales Performance dashboards (2026-08-25): ESD
  // forecasting should cover the whole remaining year, not just "today."
  const esdCutoff = `${new Date(dateTo).getUTCFullYear()}-12-31`;

  const invRows = await coqlQuery(
    `SELECT Invoice_No, Amount, Net_Product_Value1, SHIP_DATE, Sales_Order, Office_Div, Invoice_Category, ` +
      `Overage, Overage_Company_Share, Overage_Agency_Share ` +
      `FROM Invoices WHERE (SHIP_DATE >= '${dateFrom}') AND (SHIP_DATE <= '${esdCutoff}')`
  );

  // Batch-fetch cost/freight/status from linked Sales_Orders. Not all
  // invoices have a linked SO (confirmed live) - those get margin fields
  // excluded, not estimated. Status is used to (a) exclude Superceded/On
  // Hold/Cancelled orders entirely and (b) determine the "Shipped" vs
  // "Shipped+ESD" split.
  const soIds = [...new Set(invRows.map((r) => r.Sales_Order && r.Sales_Order.id).filter(Boolean))];
  const soDataById = {};
  const CHUNK = 50; // Zoho COQL's "id in (...)" caps at 50 values per query (confirmed live 2026-08-23)
  for (let i = 0; i < soIds.length; i += CHUNK) {
    const chunkIds = soIds.slice(i, i + CHUNK);
    const idList = chunkIds.map((id) => `'${id}'`).join(',');
    const soRows = await coqlQuery(
      `SELECT id, Status, Gen_Cost_TTL, Freight_Amount_Domestic, Post_Factory_Freight FROM Sales_Orders WHERE id in (${idList})`
    );
    for (const so of soRows) {
      soDataById[so.id] = {
        status: so.Status,
        cost: Number(so.Gen_Cost_TTL || 0),
        freight: Number(so.Freight_Amount_Domestic || 0) + Number(so.Post_Factory_Freight || 0)
      };
    }
  }

  const EXCLUDED_SO_STATUSES = ['Superceded', 'Order On Hold', 'Order Cancelled'];

  for (const row of invRows) {
    const soId = row.Sales_Order && row.Sales_Order.id;
    const soInfo = soId ? soDataById[soId] : null;

    // Exclude invoices whose linked order is Superceded / On Hold /
    // Cancelled - per Bosun (2026-08-25), only valid invoices count toward
    // any of the three totals below. An invoice with no linked SO at all is
    // NOT excluded here (that only affects margin, handled further down) -
    // it simply can't be checked against this exclusion list.
    if (soInfo && EXCLUDED_SO_STATUSES.includes(soInfo.status)) continue;

    const amount = Number(row.Amount || 0);
    const netProductValue = Number(row.Net_Product_Value1 || 0);
    const overageAgency = Number(row.Overage_Agency_Share || 0);
    const overageCompany = Number(row.Overage_Company_Share || 0);

    const b = bucket(periodKey(row.SHIP_DATE, granularity));
    const office = normalizeOffice(row.Office_Div);
    b.invoiceTotal += amount;
    if (office === 'NY') b.invoiceTotalNY += amount;
    else if (office === 'NJ') b.invoiceTotalNJ += amount;
    b.invoiceCount += 1;
    b.netProductValue += netProductValue;
    if (office === 'NY') b.netProductValueNY += netProductValue;
    else if (office === 'NJ') b.netProductValueNJ += netProductValue;
    b.overageAgencyShare += overageAgency;
    b.overageCompanyShare += overageCompany;

    // Three-way split - see emptyPeriod() for the full explanation.
    if (row.Invoice_Category === 'Invoice') {
      b.invoiceShippedESDTotal += amount;
      if (office === 'NY') b.invoiceShippedESDTotalNY += amount;
      else if (office === 'NJ') b.invoiceShippedESDTotalNJ += amount;

      if (soInfo && soInfo.status === 'Shipped') {
        b.invoiceShippedTotal += amount;
        if (office === 'NY') b.invoiceShippedTotalNY += amount;
        else if (office === 'NJ') b.invoiceShippedTotalNJ += amount;
      }
    } else if (row.Invoice_Category === 'Proforma') {
      b.invoiceProformaPendingTotal += amount;
      if (office === 'NY') b.invoiceProformaPendingTotalNY += amount;
      else if (office === 'NJ') b.invoiceProformaPendingTotalNJ += amount;
    }

    const tariffRate = tariffRateFor(row.SHIP_DATE);

    if (!soInfo || tariffRate === null) {
      // Can't compute a trustworthy margin for this invoice - exclude from
      // margin totals rather than silently treating missing data as zero.
      b.marginExcludedCount += 1;
      b.marginExcludedValue += amount;
      continue;
    }

    const tariff = netProductValue * tariffRate;
    const margin = netProductValue - soInfo.cost - soInfo.freight - tariff;

    b.costOfGoods += soInfo.cost;
    b.freightTotal += soInfo.freight;
    b.tariffTotal += tariff;
    b.marginTotal += margin;
    if (office === 'NY') b.marginTotalNY += margin;
    else if (office === 'NJ') b.marginTotalNJ += margin;
  }

  const sortedKeys = Object.keys(periods).sort();
  return sortedKeys.map((key) => {
    const p = periods[key];
    return {
      period: key,
      ...round2All(p),
      marginPct: p.netProductValue > 0 ? (p.marginTotal / p.netProductValue) * 100 : null
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

module.exports = { getInvoiceDashboard, tariffRateFor };
