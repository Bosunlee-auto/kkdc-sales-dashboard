// public/invoice-drilldown.js
// Click-through drill-down for the Total Invoice dashboard's 4 charts
// (Invoice Total/NPV, Overage, Margin components, Margin %). Click any point
// and see the underlying Invoices records for that period, with CSV export -
// same idea as public/drilldown.js on the Sales dashboards, but a separate,
// self-contained implementation since Invoices records have a different
// shape (Invoice No, Ship Date, Office, NPV, Cost/Freight/Tariff/Margin,
// Overage) than Sales_Orders/Quotes. Loaded only by total-invoice.html.

const CRM_ORG_ID = '657846854';
// Confirmed live via ZohoCRM_getModuleByApiName (2026-09-05): Invoices'
// module_name (the actual URL tab-path segment) is 'Invoices' - unlike
// Sales_Orders, whose module_name is 'SalesOrders', this one matches its
// api_name exactly.
function invDdCrmUrl(invoiceId) {
  if (!invoiceId) return null;
  return `https://crm.zoho.com/crm/org${CRM_ORG_ID}/tab/Invoices/${invoiceId}`;
}

function injectInvoiceDrilldownModal() {
  const style = document.createElement('style');
  style.textContent = `
    .inv-dd-overlay {
      position: fixed; inset: 0; background: rgba(17, 20, 24, 0.45);
      display: none; align-items: flex-start; justify-content: center;
      padding: 40px 20px; z-index: 1000; overflow-y: auto;
    }
    .inv-dd-overlay.open { display: flex; }
    .inv-dd-modal {
      background: #fff; border-radius: 10px; max-width: 1200px; width: 100%;
      box-shadow: 0 12px 40px rgba(0,0,0,0.25); overflow: hidden;
    }
    .inv-dd-modal-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 14px 20px; border-bottom: 1px solid #e5e7eb; background: #fafafa;
    }
    .inv-dd-modal-title { font-size: 14px; font-weight: 600; color: #1a1d1f; }
    .inv-dd-modal-sub { font-size: 12px; color: #6b7280; margin-top: 2px; }
    .inv-dd-modal-close {
      border: none; background: none; font-size: 20px; line-height: 1; cursor: pointer;
      color: #6b7280; padding: 4px 8px;
    }
    .inv-dd-modal-close:hover { color: #1a1d1f; }
    .inv-dd-modal-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 10px 20px 0; }
    .inv-dd-export-btn {
      font-size: 11px; padding: 5px 12px; border-radius: 6px; border: 1px solid #d1d5db;
      background: #fff; color: #1a1d1f; cursor: pointer; font-weight: 500;
    }
    .inv-dd-export-btn:hover { border-color: #1a1d1f; background: #f5f5f5; }
    .inv-dd-modal-body { max-height: 65vh; overflow: auto; padding: 0; }
    .inv-dd-table { width: 100%; font-size: 12px; border-collapse: collapse; }
    .inv-dd-table th, .inv-dd-table td {
      padding: 7px 12px; text-align: right; border-bottom: 1px solid #eef0f2; white-space: nowrap;
    }
    .inv-dd-table th:first-child, .inv-dd-table td:first-child { text-align: left; }
    .inv-dd-table th:nth-child(2), .inv-dd-table td:nth-child(2) { text-align: left; }
    .inv-dd-table th {
      position: sticky; top: 0; background: #fff; color: #6b7280; font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.03em; font-size: 10px; border-bottom: 1px solid #e5e7eb;
    }
    .inv-dd-table tbody tr.inv-dd-row-linked { cursor: pointer; }
    .inv-dd-table tbody tr:hover { background: #fafbfc; }
    .inv-dd-table tbody tr.inv-dd-row-linked:hover { background: #eef4ff; }
    .inv-dd-state { padding: 40px 20px; text-align: center; color: #6b7280; font-size: 13px; }
    .inv-dd-modal-footer {
      padding: 8px 20px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #6b7280; background: #fafafa;
    }
    .inv-dd-excluded { color: #9ca3af; font-style: italic; }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.className = 'inv-dd-overlay';
  overlay.id = 'invDdOverlay';
  overlay.innerHTML = `
    <div class="inv-dd-modal">
      <div class="inv-dd-modal-header">
        <div>
          <div class="inv-dd-modal-title" id="invDdTitle"></div>
          <div class="inv-dd-modal-sub" id="invDdSub"></div>
        </div>
        <button class="inv-dd-modal-close" id="invDdClose" aria-label="Close">&times;</button>
      </div>
      <div class="inv-dd-modal-actions">
        <button class="inv-dd-export-btn" id="invDdExport">Export CSV</button>
      </div>
      <div class="inv-dd-modal-body" id="invDdBody">
        <div class="inv-dd-state">Loading...</div>
      </div>
      <div class="inv-dd-modal-footer" id="invDdFooter"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('invDdClose').addEventListener('click', closeInvoiceDrilldown);
  document.getElementById('invDdExport').addEventListener('click', exportInvoiceDrilldownCSV);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeInvoiceDrilldown(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInvoiceDrilldown(); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectInvoiceDrilldownModal);
} else {
  injectInvoiceDrilldownModal();
}

function closeInvoiceDrilldown() {
  document.getElementById('invDdOverlay').classList.remove('open');
}

function invDdFmtUSD(v) {
  return (v || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

const INV_CHART_TITLES = {
  invoice: 'Invoice Total vs. Net Product Value',
  overage: 'Overage',
  margin: 'Margin components',
  marginPct: 'Margin %'
};

let invDdCurrentRecords = [];
let invDdCurrentLabel = '';

/**
 * chartKey: 'invoice' | 'overage' | 'margin' | 'marginPct' - only affects the
 * modal title and CSV filename; all four pull the same underlying record set
 * for the period, since they're just different views of the same invoices.
 * period: chart x-axis label, e.g. '2026-04'
 * granularity: 'month' | 'quarter' | 'year'
 */
async function openInvoiceDrilldown(chartKey, period, granularity) {
  const overlay = document.getElementById('invDdOverlay');
  const body = document.getElementById('invDdBody');
  const title = document.getElementById('invDdTitle');
  const sub = document.getElementById('invDdSub');
  const footer = document.getElementById('invDdFooter');

  title.textContent = `${INV_CHART_TITLES[chartKey] || chartKey} — ${period}`;
  sub.textContent = 'Underlying invoices for this period';
  body.innerHTML = '<div class="inv-dd-state">Loading...</div>';
  footer.textContent = '';
  invDdCurrentRecords = [];
  invDdCurrentLabel = `${INV_CHART_TITLES[chartKey] || chartKey} ${period}`;
  overlay.classList.add('open');

  try {
    const res = await fetch(`/api/dashboard/total-invoice/drilldown?period=${encodeURIComponent(period)}&granularity=${granularity}`);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Request failed (${res.status})`);
    }
    const { records } = await res.json();
    invDdCurrentRecords = records;
    renderInvoiceDrilldownTable(records);
    footer.textContent = `Total Records ${records.length}`;
  } catch (err) {
    body.innerHTML = `<div class="inv-dd-state">Couldn't load detail: ${err.message}</div>`;
  }
}

function invDdEscapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInvoiceDrilldownTable(records) {
  const body = document.getElementById('invDdBody');
  if (!records || records.length === 0) {
    body.innerHTML = '<div class="inv-dd-state">No invoices for this period.</div>';
    return;
  }

  const headerCols = ['Invoice No.', 'Ship Date', 'Office', 'Status', 'Amount', 'Net Product Value',
    'Cost', 'Freight', 'Tariff', 'Margin', 'Overage — Agency', 'Overage — KKDC', 'Sales Order'];

  const rowsHtml = records.map((r) => {
    const url = invDdCrmUrl(r.id);
    const rowAttrs = url ? ` class="inv-dd-row-linked" data-url="${invDdEscapeHtml(url)}" title="Open this Invoice in Zoho CRM"` : '';
    const marginCell = r.marginExcluded
      ? '<span class="inv-dd-excluded">excluded</span>'
      : invDdFmtUSD(r.margin);
    const costCell = r.cost === null ? '<span class="inv-dd-excluded">—</span>' : invDdFmtUSD(r.cost);
    const freightCell = r.freight === null ? '<span class="inv-dd-excluded">—</span>' : invDdFmtUSD(r.freight);
    const tariffCell = r.tariff === null ? '<span class="inv-dd-excluded">—</span>' : invDdFmtUSD(r.tariff);
    return `<tr${rowAttrs}>
      <td>${invDdEscapeHtml(r.invoiceNo)}</td>
      <td>${r.shipDate ? String(r.shipDate).slice(0, 10) : ''}</td>
      <td>${invDdEscapeHtml(r.office)}</td>
      <td>${invDdEscapeHtml(r.status)}</td>
      <td>${invDdFmtUSD(r.amount)}</td>
      <td>${invDdFmtUSD(r.netProductValue)}</td>
      <td>${costCell}</td>
      <td>${freightCell}</td>
      <td>${tariffCell}</td>
      <td>${marginCell}</td>
      <td>${invDdFmtUSD(r.overageAgency)}</td>
      <td>${invDdFmtUSD(r.overageCompany)}</td>
      <td>${invDdEscapeHtml(r.soSubject)}</td>
    </tr>`;
  }).join('');

  body.innerHTML = `
    <table class="inv-dd-table">
      <thead><tr>${headerCols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;

  body.querySelectorAll('tr.inv-dd-row-linked').forEach((tr) => {
    tr.addEventListener('click', () => {
      const url = tr.getAttribute('data-url');
      if (url) window.open(url, '_blank', 'noopener');
    });
  });
}

function invDdCsvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function exportInvoiceDrilldownCSV() {
  if (!invDdCurrentRecords || invDdCurrentRecords.length === 0) return;
  const headers = ['Invoice No.', 'Ship Date', 'Office', 'Status', 'Amount', 'Net Product Value',
    'Cost', 'Freight', 'Tariff', 'Margin', 'Overage Agency', 'Overage KKDC', 'Sales Order Subject'];

  const rows = invDdCurrentRecords.map((r) => [
    r.invoiceNo,
    r.shipDate ? String(r.shipDate).slice(0, 10) : '',
    r.office,
    r.status,
    r.amount,
    r.netProductValue,
    r.cost === null ? '' : r.cost,
    r.freight === null ? '' : r.freight,
    r.tariff === null ? '' : r.tariff,
    r.marginExcluded ? '' : r.margin,
    r.overageAgency,
    r.overageCompany,
    r.soSubject
  ]);

  const csv = [headers, ...rows].map((row) => row.map(invDdCsvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeLabel = invDdCurrentLabel.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  a.href = url;
  a.download = `${safeLabel || 'invoice-drilldown'}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Attach drill-down click handling to a Chart.js config's options object, in
 * place. Call BEFORE passing options into `new Chart(...)`.
 * chartKey: 'invoice' | 'overage' | 'margin' | 'marginPct' (only affects the
 *   modal title/CSV filename - see openInvoiceDrilldown).
 * getGranularity: function returning the current granularity string.
 */
function attachInvoiceChartDrilldownOnClick(options, chartKey, getGranularity) {
  const existingOnClick = options.onClick;
  options.onClick = (evt, elements, chart) => {
    if (existingOnClick) existingOnClick(evt, elements, chart);
    if (!elements || elements.length === 0) return;
    const period = chart.data.labels[elements[0].index];
    if (!period) return;
    openInvoiceDrilldown(chartKey, period, getGranularity());
  };
  const existingOnHover = options.onHover;
  options.onHover = (evt, elements, chart) => {
    if (existingOnHover) existingOnHover(evt, elements, chart);
    const el = evt.native ? evt.native.target : evt.target;
    if (!el) return;
    el.style.cursor = (elements && elements.length > 0) ? 'pointer' : 'default';
  };
}
