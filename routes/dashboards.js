// routes/dashboards.js
const express = require('express');
const router = express.Router();
const { requireDashboard } = require('./auth');
const { getOfficeSalesPerformance } = require('../lib/officeSales');
const { getInvoiceDashboard } = require('../lib/invoiceDashboard');

function parseParams(req) {
  return {
    from: req.query.from || '2020-01-01',
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

module.exports = router;
