// routes/dashboards.js
const express = require('express');
const router = express.Router();
const { requireDashboard } = require('./auth');
const { getOfficeSalesPerformance } = require('../lib/officeSales');
const { getInvoiceDashboard } = require('../lib/invoiceDashboard');

// Same helper as server.js's shiftYear - duplicated here (rather than
// exported/imported) since it's a one-line pure function and this router
// shouldn't need to reach back into server.js internals for it.
function shiftYear(isoDate, years) {
  const d = new Date(isoDate);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

function parseParams(req) {
  return {
    from: req.query.from || `${new Date().getFullYear()}-01-01`,
    to: req.query.to || new Date().toISOString().slice(0, 10),
    granularity: req.query.granularity || 'month'
  };
}

// GET /api/dashboard/ny-sales
router.get('/ny-sales', requireDashboard('NY'), async (req, res) => {
  try {
    const { from, to, granularity } = parseParams(req);
    const data = await getOfficeSalesPerformance('NY', from, to, granularity);
    res.json({ data });
  } catch (err) {
    console.error('ny-sales error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/nj-sales
router.get('/nj-sales', requireDashboard('NJ'), async (req, res) => {
  try {
    const { from, to, granularity } = parseParams(req);
    const data = await getOfficeSalesPerformance('NJ', from, to, granularity);
    res.json({ data });
  } catch (err) {
    console.error('nj-sales error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/total-sales
router.get('/total-sales', requireDashboard('TOTAL_SALES'), async (req, res) => {
  try {
    const { from, to, granularity } = parseParams(req);
    const data = await getOfficeSalesPerformance('TOTAL', from, to, granularity);
    res.json({ data });
  } catch (err) {
    console.error('total-sales error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/total-invoice
router.get('/total-invoice', requireDashboard('TOTAL_INVOICE'), async (req, res) => {
  try {
    const { from, to, granularity } = parseParams(req);
    const data = await getInvoiceDashboard(from, to, granularity);
    res.json({ data });
  } catch (err) {
    console.error('total-invoice error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/total-invoice/yoy?from=2026-01-01&to=2026-09-05&granularity=month
// Same window, shifted exactly one year prior - mirrors
// /api/sales-performance/yoy in server.js (and its 2026-09-05 fix: the
// prior window must stay bounded at the shifted `to` date, not stretched to
// that year's Dec 31 - see the esdCutoff fix in lib/invoiceDashboard.js).
//
// NOTE: Forecast and Overdue are deliberately NOT meaningful here and are
// left out of what the frontend should treat as a YoY comparison - both are
// "as of right now" snapshots (bucketed by today's real date inside
// getInvoiceDashboard, independent of the requested from/to), not a
// historical time series. Running this for a past window doesn't produce
// "Forecast/Overdue as it stood back then" - Zoho has no such record - it
// would just return today's live Forecast/Overdue again under the "prior"
// label, which is misleading. Shipped, Scheduled, their Subtotal, and
// Margin/Overage are genuinely Ship_Date-driven and safe to compare.
router.get('/total-invoice/yoy', requireDashboard('TOTAL_INVOICE'), async (req, res) => {
  try {
    const { from, to, granularity } = parseParams(req);
    const priorFrom = shiftYear(from, -1);
    const priorTo = shiftYear(to, -1);

    const [current, prior] = await Promise.all([
      getInvoiceDashboard(from, to, granularity),
      getInvoiceDashboard(priorFrom, priorTo, granularity)
    ]);

    res.json({ current, prior, priorFrom, priorTo });
  } catch (err) {
    console.error('total-invoice yoy error', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
