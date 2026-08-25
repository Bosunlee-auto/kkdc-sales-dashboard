// lib/latencyAnalysis.js
// Latency Analysis - answers "how long after quoting does an order actually
// come in, and how long after that does it ship?" Per Bosun (2026-08-24):
// this is more useful than the Conversion Rate chart, which divides
// independently-date-bucketed totals (Quote Date bucket vs PO Date bucket)
// and therefore mixes unrelated quotes and orders together - producing
// misleading spikes (e.g. 350% in one month) that don't reflect any real
// lineage. This module instead follows the SAME order's actual linked quote
// via the Quote_Name lookup field on Sales_Orders, so every latency number
// is a real elapsed-time measurement for one specific deal.
//
// Data quality note (confirmed live 2026-08-24): Quote "Quoted" dates can be
// backdated or postdated relative to the order's real PO_Date (e.g. a
// follow-up/revised quote created after the order already existed) -
// verified live with a real record (PO_Date 2026-01-01, linked Quote's
// Quoted date 2026-03-09 - a negative 67-day "latency"). These aren't
// excluded silently; they're counted separately as anomalies so the
// reported averages/medians reflect only genuine forward-moving latencies.
//
// REVISED 2026-08-24 per Bosun feedback:
//   1. Added "First Quote -> Order" alongside the existing "Linked Quote ->
//      Order". The linked quote (Sales_Orders.Quote_Name) is whichever
//      specific revision the order was actually placed against - which may
//      NOT be the first quote ever issued for that project if it went
//      through revisions first. First-Quote uses QREF (the quote-lineage
//      key, same one used in getQuoteSnapshotByPeriod) to find the EARLIEST
//      Quoted date across all revisions sharing that QREF, giving the true
//      "first contact to order" sales-cycle length.
//   2. Replaced "Quote -> Ship" (not useful per Bosun) with "Payment ->
//      Ship" - a real fulfillment lead-time metric, sourced from Invoices
//      (Audo_Last_Payment_Date -> SHIP_DATE). IMPORTANT: only meaningful for
//      prepaid (Proforma/ADV) customers, who pay BEFORE production starts.
//      NET30 customers pay ~30 days AFTER shipment (confirmed in TUS-SOP-004
//      Section 3), so a negative payment-to-ship gap for them is normal AR
//      timing, not a data problem - those are reported separately as
//      "post-shipment collections", not folded into the lead-time average.

const { coqlQuery } = require('./zoho');
const { toDisplay, BUCKET, CANCELLED_STATUSES, NOT_CONFIRMED_STATUSES, SUPERCEDED_STATUSES } = require('./statusMap');

const QUOTE_TO_ORDER_BUCKETS = [
  { label: '0-7 days', min: 0, max: 7 },
  { label: '8-14 days', min: 8, max: 14 },
  { label: '15-30 days', min: 15, max: 30 },
  { label: '31-60 days', min: 31, max: 60 },
  { label: '61-90 days', min: 61, max: 90 },
  { label: '90+ days', min: 91, max: Infinity }
];

const ORDER_TO_SHIP_BUCKETS = [
  { label: '0-3 days', min: 0, max: 3 },
  { label: '4-7 days', min: 4, max: 7 },
  { label: '8-14 days', min: 8, max: 14 },
  { label: '15-30 days', min: 15, max: 30 },
  { label: '31-60 days', min: 31, max: 60 },
  { label: '60+ days', min: 61, max: Infinity }
];

const PAYMENT_TO_SHIP_BUCKETS = [
  { label: '0-7 days', min: 0, max: 7 },
  { label: '8-14 days', min: 8, max: 14 },
  { label: '15-30 days', min: 15, max: 30 },
  { label: '31-45 days', min: 31, max: 45 },
  { label: '46-60 days', min: 46, max: 60 },
  { label: '60+ days', min: 61, max: Infinity }
];

function daysBetween(fromStr, toStr) {
  const from = new Date(fromStr);
  const to = new Date(toStr);
  return Math.round((to - from) / 86400000);
}

function median(sortedArr) {
  if (sortedArr.length === 0) return null;
  const mid = Math.floor(sortedArr.length / 2);
  return sortedArr.length % 2 === 0 ? (sortedArr[mid - 1] + sortedArr[mid]) / 2 : sortedArr[mid];
}

function average(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((a, v) => a + v, 0) / arr.length;
}

function bucketDistribution(values, buckets) {
  return buckets.map((b) => ({
    label: b.label,
    count: values.filter((v) => v >= b.min && v <= b.max).length
  }));
}

function summarize(values, buckets) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    avgDays: average(values),
    medianDays: median(sorted),
    distribution: bucketDistribution(values, buckets)
  };
}

async function getLatencyAnalysis(dateFrom, dateTo, office = null) {
  // --- Part 1: Quote -> Order -> Ship, from Sales_Orders -------------------
  const soRows = await coqlQuery(
    `SELECT id, PO_Date, Ship_Date, Status, Quote_Name, NY_Office_Full_Credit, NJ_Office_Full_Credit
     FROM Sales_Orders
     WHERE (PO_Date >= '${dateFrom}') AND (PO_Date <= '${dateTo}')`
  );

  const relevantRows = soRows.filter((row) => {
    const displayStatus = toDisplay(row.Status);
    if (SUPERCEDED_STATUSES.includes(displayStatus)) return false;
    if (NOT_CONFIRMED_STATUSES.includes(displayStatus)) return false;
    if (CANCELLED_STATUSES.includes(displayStatus)) return false;
    if (office === 'NY' && !(Number(row.NY_Office_Full_Credit) > 0)) return false;
    if (office === 'NJ' && !(Number(row.NJ_Office_Full_Credit) > 0)) return false;
    return true;
  });

  // Resolve each linked quote's own Quoted date AND its QREF (lineage key).
  const quoteIds = [...new Set(relevantRows.map((r) => r.Quote_Name && r.Quote_Name.id).filter(Boolean))];
  const quoteInfoById = {}; // id -> { quoted, qref }
  const CHUNK = 50; // Zoho COQL's "id in (...)" caps at 50 values per query
  const idChunkPromises = [];
  for (let i = 0; i < quoteIds.length; i += CHUNK) {
    const chunk = quoteIds.slice(i, i + CHUNK);
    const idList = chunk.map((id) => `'${id}'`).join(',');
    idChunkPromises.push(coqlQuery(`SELECT id, Created_Time, QREF FROM Quotes WHERE id in (${idList})`));
  }
  const idChunkResults = await Promise.all(idChunkPromises);
  for (const rows of idChunkResults) {
    for (const q of rows) {
      quoteInfoById[q.id] = { created: q.Created_Time, qref: q.QREF };
    }
  }

  // First-Quote-per-lineage: find the EARLIEST creation timestamp across
  // every revision sharing each QREF (not just the specific revision linked
  // to the order), so "First Quote -> Order" reflects true first-contact
  // date even if the order was placed against a later revision.
  //
  // Uses Created_Time, NOT the "Quoted" field. Confirmed live 2026-08-24:
  // "Quoted" is a business-set date that can be backdated/postdated freely
  // (documented elsewhere in this codebase re: getQuoteSnapshotByPeriod) -
  // one real record had Quoted=2026-03-09 but Created_Time=2025-12-30 for a
  // quote linked to an order with PO_Date=2026-01-01. Using "Quoted" made
  // this look like a -67-day anomaly (quote dated after the order); using
  // Created_Time correctly shows the quote was entered 2 days BEFORE the
  // order, which is what actually happened.
  const qrefs = [...new Set(Object.values(quoteInfoById).map((v) => v.qref).filter(Boolean))];
  const firstQuoteDateByQref = {};
  const qrefChunkPromises = [];
  for (let i = 0; i < qrefs.length; i += CHUNK) {
    const chunk = qrefs.slice(i, i + CHUNK);
    const qrefList = chunk.map((q) => `'${q}'`).join(',');
    qrefChunkPromises.push(coqlQuery(`SELECT QREF, Created_Time FROM Quotes WHERE QREF in (${qrefList})`));
  }
  const qrefChunkResults = await Promise.all(qrefChunkPromises);
  for (const rows of qrefChunkResults) {
    for (const r of rows) {
      if (!r.Created_Time || !r.QREF) continue;
      const existing = firstQuoteDateByQref[r.QREF];
      if (!existing || r.Created_Time < existing) firstQuoteDateByQref[r.QREF] = r.Created_Time;
    }
  }

  const linkedQ2ODays = [];
  const firstQ2ODays = [];
  const o2sDays = [];
  let noQuoteLinkedCount = 0;
  let linkedQ2OAnomalies = 0;
  let firstQ2OAnomalies = 0;
  let o2sAnomalies = 0;

  for (const row of relevantRows) {
    const quoteId = row.Quote_Name && row.Quote_Name.id;
    const info = quoteId ? quoteInfoById[quoteId] : null;

    if (!info || !info.created) {
      noQuoteLinkedCount += 1;
    } else {
      const linkedQ2O = daysBetween(info.created, row.PO_Date);
      if (linkedQ2O < 0) linkedQ2OAnomalies += 1;
      else linkedQ2ODays.push(linkedQ2O);

      const firstDate = info.qref ? firstQuoteDateByQref[info.qref] : null;
      if (firstDate) {
        const firstQ2O = daysBetween(firstDate, row.PO_Date);
        if (firstQ2O < 0) firstQ2OAnomalies += 1;
        else firstQ2ODays.push(firstQ2O);
      }
    }

    const displayStatus = toDisplay(row.Status);
    if (displayStatus === BUCKET.SHIPPED && row.Ship_Date) {
      const o2s = daysBetween(row.PO_Date, row.Ship_Date);
      if (o2s < 0) o2sAnomalies += 1;
      else o2sDays.push(o2s);
    }
  }

  // --- Part 2: Vendor Order -> Ship lead time, from Purchase_Orders --------
  // Per Bosun (2026-08-24): more direct than payment timing - this is the
  // actual factory/vendor fulfillment lead time. Purchase_Orders.OUS_Ref
  // links each vendor PO back to the originating Sales_Order (confirmed
  // live); the Sales_Order's own Ship_Date is used as the ship endpoint
  // (Purchase_Orders' own Ship_Date field is inconsistently populated).
  // NOTE: an SO can have multiple Purchase_Orders (multiple vendors/partial
  // shipments, per PUS = FUS+ZUS shared module) - each vendor PO is counted
  // as its own lead-time data point, since each represents a real vendor
  // fulfillment leg.
  const poRows = await coqlQuery(
    `SELECT id, PO_Date, ETD, OUS_Ref, Territory_Div FROM Purchase_Orders
     WHERE (PO_Date >= '${dateFrom}') AND (PO_Date <= '${dateTo}')`
  );

  const soIdsForVendor = [...new Set(poRows.map((r) => r.OUS_Ref && r.OUS_Ref.id).filter(Boolean))];
  const soShipInfoById = {}; // id -> { shipDate, status, nyCredit, njCredit }
  const soChunkPromises = [];
  for (let i = 0; i < soIdsForVendor.length; i += CHUNK) {
    const chunk = soIdsForVendor.slice(i, i + CHUNK);
    const idList = chunk.map((id) => `'${id}'`).join(',');
    soChunkPromises.push(
      coqlQuery(`SELECT id, Ship_Date, Status, NY_Office_Full_Credit, NJ_Office_Full_Credit FROM Sales_Orders WHERE id in (${idList})`)
    );
  }
  const soChunkResults = await Promise.all(soChunkPromises);
  for (const rows of soChunkResults) {
    for (const so of rows) {
      soShipInfoById[so.id] = {
        shipDate: so.Ship_Date,
        status: toDisplay(so.Status),
        nyCredit: Number(so.NY_Office_Full_Credit || 0),
        njCredit: Number(so.NJ_Office_Full_Credit || 0)
      };
    }
  }

  const vendorToShipDays = [];
  const vendorToESDDays = []; // promised lead time (PO_Date -> ETD) - captured even for not-yet-shipped POs
  let vendorToShipAnomalies = 0; // shipped before the vendor PO was even placed (data entry issue)
  let vendorToESDAnomalies = 0;  // ETD dated before the vendor PO itself (data entry issue)
  let notYetShippedVendorPOs = 0;
  let noETDCount = 0;

  for (const po of poRows) {
    const soId = po.OUS_Ref && po.OUS_Ref.id;
    const soInfo = soId ? soShipInfoById[soId] : null;
    if (!soInfo) continue;

    if (office === 'NY' && !(soInfo.nyCredit > 0)) continue;
    if (office === 'NJ' && !(soInfo.njCredit > 0)) continue;

    // Promised lead time - independent of actual shipment status, since ETD
    // is set at the time the vendor PO is placed. This is the metric to use
    // for "what lead time are we currently promising", including orders
    // still in production.
    if (po.ETD) {
      const etdGap = daysBetween(po.PO_Date, po.ETD);
      if (etdGap < 0) vendorToESDAnomalies += 1;
      else vendorToESDDays.push(etdGap);
    } else {
      noETDCount += 1;
    }

    if (soInfo.status !== BUCKET.SHIPPED || !soInfo.shipDate) {
      notYetShippedVendorPOs += 1;
      continue;
    }

    const gap = daysBetween(po.PO_Date, soInfo.shipDate);
    if (gap < 0) vendorToShipAnomalies += 1;
    else vendorToShipDays.push(gap);
  }

  return {
    linkedQuoteToOrder: summarize(linkedQ2ODays, QUOTE_TO_ORDER_BUCKETS),
    firstQuoteToOrder: summarize(firstQ2ODays, QUOTE_TO_ORDER_BUCKETS),
    orderToShip: summarize(o2sDays, ORDER_TO_SHIP_BUCKETS),
    vendorOrderToShip: summarize(vendorToShipDays, PAYMENT_TO_SHIP_BUCKETS),
    vendorOrderToESD: summarize(vendorToESDDays, PAYMENT_TO_SHIP_BUCKETS),
    dataQuality: {
      totalConfirmedOrders: relevantRows.length,
      noQuoteLinkedCount,          // orders with no Quote_Name lookup at all
      linkedQuoteToOrderAnomalies: linkedQ2OAnomalies, // linked quote dated AFTER the order's PO_Date
      firstQuoteToOrderAnomalies: firstQ2OAnomalies,
      orderToShipAnomalies: o2sAnomalies,           // shipped before the order's own PO_Date (data entry issue)
      totalVendorPOs: poRows.length,
      notYetShippedVendorPOs,      // vendor PO placed but linked SO not yet shipped - excluded, not an anomaly
      vendorToShipAnomalies,       // shipped before the vendor PO was even placed (data entry issue)
      noETDCount,                  // vendor POs with no ETD set yet
      vendorToESDAnomalies         // ETD dated before the vendor PO itself (data entry issue)
    }
  };
}

module.exports = { getLatencyAnalysis };
