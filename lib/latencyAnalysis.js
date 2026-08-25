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

async function getLatencyAnalysis(dateFrom, dateTo, office = null) {
  const soRows = await coqlQuery(
    `SELECT id, PO_Date, Ship_Date, Status, Quote_Name, NY_Office_Full_Credit, NJ_Office_Full_Credit, Quoted_Price
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

  const quoteIds = [...new Set(relevantRows.map((r) => r.Quote_Name && r.Quote_Name.id).filter(Boolean))];
  const quoteDateById = {};
  const CHUNK = 50;
  const chunkPromises = [];
  for (let i = 0; i < quoteIds.length; i += CHUNK) {
    const chunk = quoteIds.slice(i, i + CHUNK);
    const idList = chunk.map((id) => `'${id}'`).join(',');
    chunkPromises.push(coqlQuery(`SELECT id, Quoted FROM Quotes WHERE id in (${idList})`));
  }
  const chunkResults = await Promise.all(chunkPromises);
  for (const rows of chunkResults) {
    for (const q of rows) {
      if (q.Quoted) quoteDateById[q.id] = q.Quoted;
    }
  }

  const quoteToOrderDays = [];
  const orderToShipDays = [];
  const quoteToShipDays = [];
  let noQuoteLinkedCount = 0;
  let quoteToOrderAnomalies = 0;
  let orderToShipAnomalies = 0;

  for (const row of relevantRows) {
    const quoteId = row.Quote_Name && row.Quote_Name.id;
    const quoteDate = quoteId ? quoteDateById[quoteId] : null;

    if (!quoteDate) {
      noQuoteLinkedCount += 1;
      continue;
    }

    const q2o = daysBetween(quoteDate, row.PO_Date);
    if (q2o < 0) {
      quoteToOrderAnomalies += 1;
    } else {
      quoteToOrderDays.push(q2o);
    }

    const displayStatus = toDisplay(row.Status);
    if (displayStatus === BUCKET.SHIPPED && row.Ship_Date) {
      const o2s = daysBetween(row.PO_Date, row.Ship_Date);
      if (o2s < 0) {
        orderToShipAnomalies += 1;
      } else {
        orderToShipDays.push(o2s);
        if (q2o >= 0) quoteToShipDays.push(q2o + o2s);
      }
    }
  }

  const sortedQ2O = [...quoteToOrderDays].sort((a, b) => a - b);
  const sortedO2S = [...orderToShipDays].sort((a, b) => a - b);
  const sortedQ2S = [...quoteToShipDays].sort((a, b) => a - b);

  return {
    quoteToOrder: {
      count: quoteToOrderDays.length,
      avgDays: average(quoteToOrderDays),
      medianDays: median(sortedQ2O),
      distribution: bucketDistribution(quoteToOrderDays, QUOTE_TO_ORDER_BUCKETS)
    },
    orderToShip: {
      count: orderToShipDays.length,
      avgDays: average(orderToShipDays),
      medianDays: median(sortedO2S),
      distribution: bucketDistribution(orderToShipDays, ORDER_TO_SHIP_BUCKETS)
    },
    quoteToShip: {
      count: quoteToShipDays.length,
      avgDays: average(quoteToShipDays),
      medianDays: median(sortedQ2S)
    },
    dataQuality: {
      totalConfirmedOrders: relevantRows.length,
      noQuoteLinkedCount,
      quoteToOrderAnomalies,
      orderToShipAnomalies
    }
  };
}

module.exports = { getLatencyAnalysis };
