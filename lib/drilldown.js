// lib/drilldown.js
// Record-level drill-down for the funnel chart (Quote / Order PO / Shipped +
// ESD / Shipped realized) on the NY, NJ, and Total Sales dashboards -
// replicates the click-through-to-table behavior of the native Zoho CRM
// Analytics widgets (2026-08-26 request from Bosun).
//
// CRITICAL: each series function below mirrors the EXACT filter logic used
// to build the aggregate number in lib/salesPerformance.js::getSalesPerformance.
// If that file's bucketing logic ever changes, this file must change with it
// or the drill-down table will stop matching the number the user clicked on.
//
// Field mapping confirmed live via ZohoCRM_getFields (2026-08-26):
//   Sales_Orders.Subject          -> Subject
//   Sales_Orders.Deal_Name        -> lookup into Deals, display label "Project Name"
//   Sales_Orders.PO_Number        -> plain text, display label "Customer PO No."
//   Sales_Orders.Account_Name     -> lookup into Accounts (Specifier)
//   Deals.Deal_Name               -> plain text field, the module's own name
//   Accounts.Account_Name         -> plain text field, the module's own name
// Both Deal_Name and Account_Name come back as {id} ONLY from this app's OAuth
// client (same root cause documented in salesPerformance.js) - resolved here
// via the same chunked-batch pattern, 50 ids per COQL "id in (...)" query.

const { coqlQuery } = require('./zoho');
const { toDisplay, BUCKET, CANCELLED_STATUSES, NOT_CONFIRMED_STATUSES, SUPERCEDED_STATUSES } = require('./statusMap');

// --- period -> date-range helpers (mirrors salesPerformance.js periodKey, inverted) ---
function periodBounds(period, granularity) {
  if (granularity === 'year') {
    return { start: `${period}-01-01`, end: `${period}-12-31` };
  }
  if (granularity === 'quarter') {
    const [y, qStr] = period.split('-Q');
    const q = Number(qStr);
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const start = `${y}-${String(startMonth).padStart(2, '0')}-01`;
    const endDate = new Date(Number(y), endMonth, 0); // day 0 of next month = last day of endMonth
    const end = endDate.toISOString().slice(0, 10);
    return { start, end };
  }
  // month - period is 'YYYY-MM'
  const [y, m] = period.split('-');
  const start = `${y}-${m}-01`;
  const endDate = new Date(Number(y), Number(m), 0);
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}

// A row counts for a given office if that office's Full_Credit field is
// non-zero - same inclusion rule as getSalesPerformance (officeShare === 0
// -> excluded entirely), NOT a proportional split.
function matchesOffice(row, office) {
  if (office === 'TOTAL') return true;
  const credit = office === 'NY' ? Number(row.NY_Office_Full_Credit || 0) : Number(row.NJ_Office_Full_Credit || 0);
  return credit > 0;
}

async function resolveNames(ids, module, nameField) {
  const nameById = {};
  const uniq = [...new Set(ids)].filter(Boolean);
  if (uniq.length === 0) return nameById;
  const CHUNK = 50; // confirmed live limit for COQL "id in (...)" - see salesPerformance.js note
  const chunkPromises = [];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const idList = chunk.map((id) => `'${id}'`).join(',');
    chunkPromises.push(coqlQuery(`SELECT id, ${nameField} FROM ${module} WHERE id in (${idList})`));
  }
  const results = await Promise.all(chunkPromises);
  for (const rows of results) {
    for (const r of rows) nameById[r.id] = r[nameField] || '';
  }
  return nameById;
}

const SO_FIELDS = 'id, Subject, Quoted_Price, Status, NY_Office_Full_Credit, NJ_Office_Full_Credit, PO_Date, Ship_Date, Deal_Name, PO_Number, Account_Name';

// Series: orderPO - confirmed pipeline, bucketed by PO_Date (Order PO amount)
async function getOrderPORows(office, start, end) {
  const rows = await coqlQuery(
    `SELECT ${SO_FIELDS} FROM Sales_Orders WHERE (PO_Date >= '${start}') AND (PO_Date <= '${end}')`
  );
  return rows.filter((row) => {
    const displayStatus = toDisplay(row.Status);
    if (SUPERCEDED_STATUSES.includes(displayStatus)) return false;
    if (NOT_CONFIRMED_STATUSES.includes(displayStatus)) return false;
    if (CANCELLED_STATUSES.includes(displayStatus)) return false;
    return matchesOffice(row, office);
  });
}

// Series: shipped (realized) - Status = Shipped, bucketed by Ship_Date
async function getShippedRows(office, start, end) {
  const rows = await coqlQuery(
    `SELECT ${SO_FIELDS} FROM Sales_Orders WHERE (Ship_Date >= '${start}') AND (Ship_Date <= '${end}')`
  );
  return rows.filter((row) => toDisplay(row.Status) === BUCKET.SHIPPED && matchesOffice(row, office));
}

// Series: shippedPlusESD - union of (a) confirmed "Ordered to vendor" rows
// bucketed by PO_Date (forward-looking estimate) and (b) actually Shipped
// rows bucketed by Ship_Date. Mirrors salesPerformance.js lines ~193-231.
async function getShippedPlusESDRows(office, start, end) {
  const poRows = await coqlQuery(
    `SELECT ${SO_FIELDS} FROM Sales_Orders WHERE (PO_Date >= '${start}') AND (PO_Date <= '${end}')`
  );
  const forwardLooking = poRows.filter(
    (row) => toDisplay(row.Status) === BUCKET.ORDERED_TO_VENDOR && matchesOffice(row, office)
  );
  const shipped = await getShippedRows(office, start, end);
  const seen = new Set();
  const merged = [];
  for (const row of [...forwardLooking, ...shipped]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

// Series: quote (latest) - Quotes module, Latest=true, bucketed by Quoted date
async function getQuoteRows(office, start, end) {
  const rows = await coqlQuery(
    `SELECT id, Subject, Amount, Quoted, Territory_Div, QREF, Deal_Name, Account_Name
     FROM Quotes WHERE (Latest = true) AND (Quoted >= '${start}' AND Quoted <= '${end}')`
  );
  return rows.filter((row) => {
    if (office === 'NY') return row.Territory_Div === 'NY Territory';
    if (office === 'NJ') return row.Territory_Div === 'NJ Territory';
    return true;
  });
}

const SERIES_FETCHERS = {
  orderPO: getOrderPORows,
  shipped: getShippedRows,
  shippedPlusESD: getShippedPlusESDRows,
  quote: getQuoteRows
};

/**
 * office: 'NY' | 'NJ' | 'TOTAL'
 * series: 'quote' | 'orderPO' | 'shippedPlusESD' | 'shipped'
 * period: 'YYYY-MM' | 'YYYY-Q#' | 'YYYY' matching the funnel chart's x-axis label
 * granularity: 'month' | 'quarter' | 'year'
 */
async function getDrilldown({ office, series, period, granularity = 'month' }) {
  const fetcher = SERIES_FETCHERS[series];
  if (!fetcher) throw new Error(`Unknown drill-down series: ${series}`);
  const { start, end } = periodBounds(period, granularity);
  const rows = await fetcher(office, start, end);

  const dealIds = [];
  const acctIds = [];
  for (const row of rows) {
    if (row.Deal_Name && row.Deal_Name.id) dealIds.push(row.Deal_Name.id);
    if (row.Account_Name && row.Account_Name.id) acctIds.push(row.Account_Name.id);
  }
  const [dealNameById, acctNameById] = await Promise.all([
    resolveNames(dealIds, 'Deals', 'Deal_Name'),
    resolveNames(acctIds, 'Accounts', 'Account_Name')
  ]);

  const isQuote = series === 'quote';
  const records = rows.map((row) => {
    const dealId = row.Deal_Name && row.Deal_Name.id;
    const acctId = row.Account_Name && row.Account_Name.id;
    return {
      id: row.id,
      subject: row.Subject || '',
      amount: isQuote ? Number(row.Amount || 0) : Number(row.Quoted_Price || 0),
      poDate: row.PO_Date || null,
      shipDate: row.Ship_Date || null,
      quotedDate: row.Quoted || null,
      status: row.Status || null,
      nyCredit: Number(row.NY_Office_Full_Credit || 0),
      njCredit: Number(row.NJ_Office_Full_Credit || 0),
      projectName: dealId ? (dealNameById[dealId] || '') : '',
      customerPO: isQuote ? '' : (row.PO_Number || ''),
      qref: row.QREF || '',
      accountName: acctId ? (acctNameById[acctId] || '') : ''
    };
  });

  records.sort((a, b) => {
    const da = a.shipDate || a.poDate || a.quotedDate || '';
    const db = b.shipDate || b.poDate || b.quotedDate || '';
    return da.localeCompare(db);
  });

  return records;
}

module.exports = { getDrilldown };
