// public/drilldown.js
// Shared funnel-chart drill-down: click a point on Quote / Order PO /
// Shipped + ESD / Shipped (realized) and see the underlying Sales_Orders (or
// Quotes) records in a table, matching the native Zoho CRM Analytics
// click-through behavior. Loaded by ny-sales.html, nj-sales.html, and
// index.html - one shared implementation so all three dashboards stay in
// sync (2026-08-26).

const DRILLDOWN_SERIES_BY_LABEL = {
  'Quote (latest)': 'quote',
  'Order PO': 'orderPO',
  'Shipped + ESD': 'shippedPlusESD',
  'Shipped (realized)': 'shipped'
};

(function injectDrilldownModal() {
  const style = document.createElement('style');
  style.textContent = `
    .dd-overlay {
      position: fixed; inset: 0; background: rgba(17, 20, 24, 0.45);
      display: none; align-items: flex-start; justify-content: center;
      padding: 40px 20px; z-index: 1000; overflow-y: auto;
    }
    .dd-overlay.open { display: flex; }
    .dd-modal {
      background: #fff; border-radius: 10px; max-width: 1100px; width: 100%;
      box-shadow: 0 12px 40px rgba(0,0,0,0.25); overflow: hidden;
    }
    .dd-modal-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 14px 20px; border-bottom: 1px solid #e5e7eb; background: #fafafa;
    }
    .dd-modal-title { font-size: 14px; font-weight: 600; color: #1a1d1f; }
    .dd-modal-sub { font-size: 12px; color: #6b7280; margin-top: 2px; }
    .dd-modal-close {
      border: none; background: none; font-size: 20px; line-height: 1; cursor: pointer;
      color: #6b7280; padding: 4px 8px;
    }
    .dd-modal-close:hover { color: #1a1d1f; }
    .dd-modal-body { max-height: 65vh; overflow: auto; padding: 0; }
    .dd-table { width: 100%; font-size: 12px; border-collapse: collapse; }
    .dd-table th, .dd-table td {
      padding: 7px 12px; text-align: right; border-bottom: 1px solid #eef0f2; white-space: nowrap;
    }
    .dd-table th:first-child, .dd-table td:first-child { text-align: left; }
    .dd-table th:nth-child(2), .dd-table td:nth-child(2) { text-align: left; }
    .dd-table th {
      position: sticky; top: 0; background: #fff; color: #6b7280; font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.03em; font-size: 10px; border-bottom: 1px solid #e5e7eb;
    }
    .dd-table tbody tr:hover { background: #fafbfc; }
    .dd-state { padding: 40px 20px; text-align: center; color: #6b7280; font-size: 13px; }
    .dd-modal-footer {
      padding: 8px 20px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #6b7280; background: #fafafa;
    }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.className = 'dd-overlay';
  overlay.id = 'ddOverlay';
  overlay.innerHTML = `
    <div class="dd-modal">
      <div class="dd-modal-header">
        <div>
          <div class="dd-modal-title" id="ddTitle"></div>
          <div class="dd-modal-sub" id="ddSub"></div>
        </div>
        <button class="dd-modal-close" id="ddClose" aria-label="Close">&times;</button>
      </div>
      <div class="dd-modal-body" id="ddBody">
        <div class="dd-state">Loading...</div>
      </div>
      <div class="dd-modal-footer" id="ddFooter"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('ddClose').addEventListener('click', closeDrilldown);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDrilldown(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrilldown(); });
})();

function closeDrilldown() {
  document.getElementById('ddOverlay').classList.remove('open');
}

function ddFmtUSD(v) {
  return (v || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

const SERIES_TITLES = {
  quote: 'Quote (latest)',
  orderPO: 'Order PO',
  shippedPlusESD: 'Shipped + ESD',
  shipped: 'Shipped (realized)'
};

/**
 * office: 'NY' | 'NJ' | 'TOTAL'
 * series: 'quote' | 'orderPO' | 'shippedPlusESD' | 'shipped'
 * period: chart x-axis label, e.g. '2026-04'
 * granularity: 'month' | 'quarter' | 'year'
 */
async function openDrilldown(office, series, period, granularity) {
  const overlay = document.getElementById('ddOverlay');
  const body = document.getElementById('ddBody');
  const title = document.getElementById('ddTitle');
  const sub = document.getElementById('ddSub');
  const footer = document.getElementById('ddFooter');

  title.textContent = `${SERIES_TITLES[series] || series} — ${period}`;
  sub.textContent = `${office === 'TOTAL' ? 'Total' : office} Sales`;
  body.innerHTML = '<div class="dd-state">Loading...</div>';
  footer.textContent = '';
  overlay.classList.add('open');

  try {
    const officeParam = office === 'TOTAL' ? '' : `&office=${office}`;
    const res = await fetch(`/api/sales-performance/drilldown?series=${series}&period=${encodeURIComponent(period)}&granularity=${granularity}${officeParam}`);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Request failed (${res.status})`);
    }
    const { records } = await res.json();
    renderDrilldownTable(records, series);
    footer.textContent = `Total Records ${records.length}`;
  } catch (err) {
    body.innerHTML = `<div class="dd-state">Couldn't load detail: ${err.message}</div>`;
  }
}

function renderDrilldownTable(records, series) {
  const body = document.getElementById('ddBody');
  if (!records || records.length === 0) {
    body.innerHTML = '<div class="dd-state">No records for this period.</div>';
    return;
  }

  const isQuote = series === 'quote';
  const dateLabel = isQuote ? 'Quote Date' : 'Ship Date';
  const dateOf = (r) => isQuote ? r.quotedDate : (r.shipDate || r.poDate);

  const headerCols = isQuote
    ? ['Subject', dateLabel, 'Amount', 'Project Name', 'Account Name']
    : ['Subject', dateLabel, 'NY Full Credit', 'NJ Full Credit', 'Project Name', 'Customer PO No.', 'Account Name'];

  const rowsHtml = records.map((r) => {
    const dateStr = dateOf(r) ? String(dateOf(r)).slice(0, 10) : '';
    if (isQuote) {
      return `<tr>
        <td>${escapeHtml(r.subject || r.qref || '')}</td>
        <td>${dateStr}</td>
        <td>${ddFmtUSD(r.amount)}</td>
        <td>${escapeHtml(r.projectName)}</td>
        <td>${escapeHtml(r.accountName)}</td>
      </tr>`;
    }
    return `<tr>
      <td>${escapeHtml(r.subject)}</td>
      <td>${dateStr}</td>
      <td>${ddFmtUSD(r.nyCredit)}</td>
      <td>${ddFmtUSD(r.njCredit)}</td>
      <td>${escapeHtml(r.projectName)}</td>
      <td>${escapeHtml(r.customerPO)}</td>
      <td>${escapeHtml(r.accountName)}</td>
    </tr>`;
  }).join('');

  body.innerHTML = `
    <table class="dd-table">
      <thead><tr>${headerCols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Attach drill-down click handling to a Chart.js funnel-chart config's
 * options object, in place. Call BEFORE passing options into `new Chart(...)`.
 * office: 'NY' | 'NJ' | 'TOTAL'
 * getGranularity: function returning the current granularity string
 */
function attachFunnelDrilldownOnClick(options, office, getGranularity) {
  const existingOnClick = options.onClick;
  options.onClick = (evt, elements, chart) => {
    if (existingOnClick) existingOnClick(evt, elements, chart);
    if (!elements || elements.length === 0) return;
    const el = elements[0];
    const datasetLabel = chart.data.datasets[el.datasetIndex].label;
    const series = DRILLDOWN_SERIES_BY_LABEL[datasetLabel];
    if (!series) return; // BEP / Quota reference lines aren't clickable
    const period = chart.data.labels[el.index];
    openDrilldown(office, series, period, getGranularity());
  };
  // Chart.js needs onHover cursor feedback so users know points are clickable
  const existingOnHover = options.onHover;
  options.onHover = (evt, elements, chart) => {
    if (existingOnHover) existingOnHover(evt, elements, chart);
    const el = evt.native ? evt.native.target : evt.target;
    if (!el) return;
    if (elements && elements.length > 0) {
      const datasetLabel = chart.data.datasets[elements[0].datasetIndex].label;
      el.style.cursor = DRILLDOWN_SERIES_BY_LABEL[datasetLabel] ? 'pointer' : 'default';
    } else {
      el.style.cursor = 'default';
    }
  };
}
