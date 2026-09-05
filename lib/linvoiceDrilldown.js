// lib/invoiceDrilldown.js
// Record-level drill-down for the Total Invoice dashboard's charts (Invoice
// Total vs NPV / Overage / Margin components / Margin %) - click a chart
// point, see the underlying Invoices records for that period, matching the
// native Zoho CRM Analytics click-through behavior. Same pattern as
// lib/drilldown.js (used by the Sales dashboards' funnel chart), kept as a
// separate file since Invoices has a different shape (and a different
// exclusion/tariff/margin computation) than Sales_Orders/Quotes.
//
// CRITICAL: mirrors the EXACT filter + tariff/margin logic used in
// lib/invoiceDashboard.js::getInvoiceDashboard's main invRows loop. If that
// file's logic ever changes, this one must change with it or the drill-down
// table will stop matching the number the user clicked on.
//
// NOTE: only Shipped and Scheduled invoices are ever returned here -
// Forecast is deliberately excluded, for the same reason it's excluded from
// YoY (see routes/dashboards.js's /total-invoice/yoy comment): Forecast is
// an "as of right now" snapshot bucketed by today's real date, not tied to
// any historical Ship_Date period, so there is no meaningful "Forecast for
// period X" to drill into.

const { coqlQuery } = require('./zoho');
const { tariffRateFor } = require('./invoiceDashboard');

const EXCLUDED_SO_STATUSES = ['Superceded', 'Order On Hold', 'Order Cancelled'];

function normalizeOffice(officeDiv) {
  if (!officeDiv) return '';
  const v = String(officeDiv).toLowerCase();
  if (v.includes('nj')) return 'NJ';
  if (v.includes('ny')) return 'NY';
  return '';
}

// period -> date-range bounds. Same shape/logic as lib/drilldown.js's
// periodBounds - duplicated here rather than imported, since that file is
// scoped to the Sales dashboards and this one may need to diverge later.
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
    const endDate = new Date(Number(y), endMonth, 0);
    const end = endDate.toISOString().slice(0, 10);
    return { start, end };
  }
  const [y, m] = period.split('-');
  const start = `${y}-${m}-01`;
  const endDate = new Date(Number(y), Number(m), 0);
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}

const CHUNK = 50; // confirmed live COQL "id in (...)" limit - see invoiceDashboard.js

async function getInvoiceDrilldown({ period, granularity = 'month' }) {
  const { start, end } = periodBounds(period, granularity);

  const invRows = await coqlQuery(
    `SELECT id, Invoice_No, Amount, Net_Product_Value1, SHIP_DATE, Sales_Order, Office_Div, ` +
      `Overage, Overage_Company_Share, Overage_Agency_Share ` +
      `FROM Invoices WHERE (SHIP_DATE >= '${start}') AND (SHIP_DATE <= '${end}')`
  );

  const soIds = [...new Set(invRows.map((r) => r.Sales_Order && r.Sales_Order.id).filter(Boolean))];
  const soDataById = {};
  for (let i = 0; i < soIds.length; i += CHUNK) {
    const chunk = soIds.slice(i, i + CHUNK);
    const idList = chunk.map((id) => `'${id}'`).join(',');
    const soRows = await coqlQuery(
      `SELECT id, Subject, Status, Gen_Cost_TTL, Freight_Amount_Domestic, Post_Factory_Freight FROM Sales_Orders WHERE id in (${idList})`
    );
    for (const so of soRows) {
      soDataById[so.id] = {
        subject: so.Subject || '',
        status: so.Status,
        cost: Number(so.Gen_Cost_TTL || 0),
        freight: Number(so.Freight_Amount_Domestic || 0) + Number(so.Post_Factory_Freight || 0)
      };
    }
  }

  const records = [];
  for (const row of invRows) {
    const soId = row.Sales_Order && row.Sales_Order.id;
    const soInfo = soId ? soDataById[soId] : null;
    if (soInfo && EXCLUDED_SO_STATUSES.includes(soInfo.status)) continue;

    const amount = Number(row.Amount || 0);
    const netProductValue = Number(row.Net_Product_Value1 || 0);
    const isShipped = !!(soInfo && soInfo.status === 'Shipped');
    const tariffRate = tariffRateFor(row.SHIP_DATE);
    const marginAvailable = !!(soInfo && tariffRate !== null);
    const tariff = marginAvailable ? netProductValue * tariffRate : null;
    const margin = marginAvailable ? (netProductValue - soInfo.cost - soInfo.freight - tariff) : null;

    records.push({
      id: row.id,
      invoiceNo: row.Invoice_No || '',
      shipDate: row.SHIP_DATE || null,
      office: normalizeOffice(row.Office_Div),
      amount,
      netProductValue,
      status: isShipped ? 'Shipped' : 'Scheduled', // never 'Forecast' - see file-level note
      soSubject: soInfo ? soInfo.subject : '',
      soId: soId || null,
      overageAgency: Number(row.Overage_Agency_Share || 0),
      overageCompany: Number(row.Overage_Company_Share || 0),
      cost: soInfo ? soInfo.cost : null,
      freight: soInfo ? soInfo.freight : null,
      tariff,
      margin,
      marginExcluded: !marginAvailable
    });
  }

  records.sort((a, b) => (a.shipDate || '').localeCompare(b.shipDate || ''));
  return records;
}

module.exports = { getInvoiceDrilldown };
