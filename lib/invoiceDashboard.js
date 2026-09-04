// lib/invoiceDashboard.js
// Total Invoice dashboard. Sourced from Invoices - this is the ONLY one of the
// 4 dashboards that uses the full invoiced amount (freight/duty/S&H included),
// per Bosun (2026-08-23): "Only net product sales figures matter" for the
// Sales dashboards, but the Invoice dashboard exists specifically to show the
// real, total invoiced dollar figure.
//
// REVISED 2026-08-25 per Bosun - major correction to how "Invoice" totals are
// categorized:
//
//   Invoices.Invoice_Category ("Invoice" vs "Proforma") is NOT a financial
//   status field. It exists purely to pick which automated email template to
//   send (an invoice-with-due-date email vs. a proforma "pending payment"
//   email), and once set, it is NEVER updated afterward even after the order
//   ships and gets paid. Using it to distinguish "real" vs "pending" revenue
//   was wrong - confirmed live: 90% of "Proforma"-tagged invoices in the
//   2026 window actually had a Ship_Date from many months earlier, because
//   the category field simply never got revisited once the order actually
//   shipped. Proforma vs Invoice is dropped entirely from this file; every
//   valid invoice is just "an invoice."
//
//   Similarly, Invoices.Status ("Overdue" etc.) is ALSO not reliable as a
//   live indicator - confirmed live: querying Status='Overdue' returns 200+
//   records going back to 2019, which cannot possibly still be genuinely
//   outstanding after 6+ years. The field is set once and not revisited.
//
// The new, correct 4-way split (per Bosun, 2026-08-25) is based purely on
// the LINKED SALES ORDER's status, plus a manually-curated overdue snapshot
// (see OVERDUE_SNAPSHOT below) for the one thing that genuinely can't be
// derived reliably from CRM fields alone:
//
//   1. Shipped (Recognized)   - linked SO.Status = 'Shipped'. Full invoiced
//                               amount counts as real, recognized revenue
//                               REGARDLESS of whether payment has been
//                               received yet - shipping, not payment, is
//                               what makes it "closed" revenue for Bosun.
//   2. Overdue                - the subset of #1 that is ACTUALLY still
//                               outstanding right now. Confirmed with Bosun
//                               (2026-08-25): Invoices.Status='Overdue' data
//                               has been cleaned up and IS trustworthy for
//                               Invoice_Date >= 2025-01-01 (before that,
//                               it's stale legacy noise going back to 2019
//                               that was never revisited). Sourced live via
//                               a separate query: Status='Overdue' AND
//                               Invoice_Date >= '2025-01-01' - verified live
//                               to match Bosun's CRM export exactly (9
//                               invoices, $20,962.06, 2026-09-04). Uses each
//                               invoice's outstanding BALANCE, not its
//                               original full Amount, since partial
//                               payments may already be applied. Bucketed by
//                               Invoice_Date (not Ship_Date - 2 of the 9 has
//                               no Ship_Date at all) into whichever period
//                               contains today, since this is inherently a
//                               "right now" snapshot rather than a
//                               historical time-series metric.
//   3. Scheduled               - linked SO.Status is NOT Shipped (and not
//                               Superceded/On Hold/Cancelled), AND the
//                               invoice has a Ship_Date (ESD) on file.
//                               Counted regardless of payment status - these
//                               are considered close to certain to happen.
//   4. Forecast                - linked SO.Status is NOT Shipped (and not
//                               excluded), and there is NO Ship_Date yet -
//                               too early-stage to even have a scheduled
//                               date, so tracked separately as pipeline.
//
// #1, #3, #4 are mutually exclusive and sum to the total valid invoice
// universe. #2 is a subset flag layered on top of #1, not a separate bucket
// in the total.
//
// Margin calculation (unchanged from the original version):
//   Margin = Net_Product_Value1
//            - Gen_Cost_TTL      (Cost of Goods, from the LINKED Sales_Order)
//            - Freight           (SO.Freight_Amount_Domestic + SO.Post_Factory_Freight)
//            - Tariff            (computed - see schedule below)
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

const EXCLUDED_SO_STATUSES = ['Superceded', 'Order On Hold', 'Order Cancelled'];

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

    // The 4-way split - see the big comment at the top of this file.
    invoiceShippedTotal: 0,      // #1 - full amount, linked SO Status='Shipped'
    invoiceShippedTotalNY: 0,
    invoiceShippedTotalNJ: 0,
    invoiceOverdueTotal: 0,      // #2 - subset of #1, from OVERDUE_SNAPSHOT (uses Balance, not Amount)
    invoiceOverdueTotalNY: 0,
    invoiceOverdueTotalNJ: 0,
    invoiceScheduledTotal: 0,    // #3 - not shipped, has a Ship_Date (ESD)
    invoiceScheduledTotalNY: 0,
    invoiceScheduledTotalNJ: 0,
    invoiceForecastTotal: 0,     // #4 - not shipped, no Ship_Date yet
    invoiceForecastTotalNY: 0,
    invoiceForecastTotalNJ: 0,

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

  // Upper bound extended to Dec 31 of dateTo's year - matching the same fix
  // applied to the Sales Performance dashboards (2026-08-25): scheduled
  // (ESD) invoices should cover the whole remaining year, not just "today."
  const esdCutoff = `${new Date(dateTo).getUTCFullYear()}-12-31`;

  const invRows = await coqlQuery(
    `SELECT Invoice_No, Amount, Net_Product_Value1, SHIP_DATE, Sales_Order, Office_Div, ` +
      `Overage, Overage_Company_Share, Overage_Agency_Share ` +
      `FROM Invoices WHERE (SHIP_DATE >= '${dateFrom}') AND (SHIP_DATE <= '${esdCutoff}')`
  );

  // Batch-fetch cost/freight/status from linked Sales_Orders. Not all
  // invoices have a linked SO (confirmed live) - those get margin fields
  // excluded, not estimated. Status determines (a) exclusion of
  // Superceded/On Hold/Cancelled orders and (b) the Shipped vs
  // Scheduled/Forecast split.
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

  for (const row of invRows) {
    const soId = row.Sales_Order && row.Sales_Order.id;
    const soInfo = soId ? soDataById[soId] : null;

    // Exclude invoices whose linked order is Superceded / On Hold /
    // Cancelled - only valid invoices count toward any total below. An
    // invoice with no linked SO at all is NOT excluded here (that only
    // affects margin, handled further down) - it simply can't be checked
    // against this exclusion list.
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

    // The 4-way split (see the big comment at the top of this file).
    // Overdue (#2) is NOT computed here - it's a subset of Shipped sourced
    // from a separate live query below, since it needs its own date
    // filter (Invoice_Date, not Ship_Date) and isn't reliably tied to
    // whichever period this row's Ship_Date happens to fall into.
    const isShipped = soInfo && soInfo.status === 'Shipped';
    if (isShipped) {
      b.invoiceShippedTotal += amount;
      if (office === 'NY') b.invoiceShippedTotalNY += amount;
      else if (office === 'NJ') b.invoiceShippedTotalNJ += amount;
    } else {
      // Not shipped (and not excluded) - split by whether an ESD exists.
      if (row.SHIP_DATE) {
        b.invoiceScheduledTotal += amount;
        if (office === 'NY') b.invoiceScheduledTotalNY += amount;
        else if (office === 'NJ') b.invoiceScheduledTotalNJ += amount;
      } else {
        b.invoiceForecastTotal += amount;
        if (office === 'NY') b.invoiceForecastTotalNY += amount;
        else if (office === 'NJ') b.invoiceForecastTotalNJ += amount;
      }
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

  // --- Overdue (#2) - independent live query ------------------------------
  // Confirmed with Bosun (2026-08-25): Status='Overdue' data has been
  // cleaned up and is trustworthy from Invoice_Date >= 2025-01-01 onward
  // (verified live to exactly match a real CRM export: 9 invoices,
  // $20,962.06, as of 2026-09-04). Queried independently of the main
  // Ship_Date-ranged invRows above, since 2 of these 9 have no Ship_Date at
  // all and would otherwise never be fetched. Bucketed into whichever
  // period contains today - this is a "right now" snapshot, not a
  // historical time series, so it only appears when today falls within the
  // requested date range (e.g. browsing a past year like 2024 correctly
  // shows no Overdue figure).
  const OVERDUE_FLOOR_DATE = '2025-01-01';
  const overdueRows = await coqlQuery(
    `SELECT Invoice_No, Balance, Office_Div, Sales_Order FROM Invoices ` +
      `WHERE (Status = 'Overdue' AND Invoice_Date >= '${OVERDUE_FLOOR_DATE}')`
  );
  if (overdueRows.length > 0) {
    const overdueSoIds = [...new Set(overdueRows.map((r) => r.Sales_Order && r.Sales_Order.id).filter(Boolean))];
    const unseenSoIds = overdueSoIds.filter((id) => !soDataById[id]);
    for (let i = 0; i < unseenSoIds.length; i += CHUNK) {
      const chunkIds = unseenSoIds.slice(i, i + CHUNK);
      const idList = chunkIds.map((id) => `'${id}'`).join(',');
      const soRows = await coqlQuery(`SELECT id, Status FROM Sales_Orders WHERE id in (${idList})`);
      for (const so of soRows) {
        soDataById[so.id] = soDataById[so.id] || { status: so.Status, cost: 0, freight: 0 };
      }
    }

    const todayKey = periodKey(new Date().toISOString().slice(0, 10), granularity);
    const overdueBucket = bucket(todayKey);
    for (const row of overdueRows) {
      const soId = row.Sales_Order && row.Sales_Order.id;
      const soInfo = soId ? soDataById[soId] : null;
      if (soInfo && EXCLUDED_SO_STATUSES.includes(soInfo.status)) continue;

      const balance = Number(row.Balance || 0);
      const office = normalizeOffice(row.Office_Div);
      overdueBucket.invoiceOverdueTotal += balance;
      if (office === 'NY') overdueBucket.invoiceOverdueTotalNY += balance;
      else if (office === 'NJ') overdueBucket.invoiceOverdueTotalNJ += balance;
    }
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
