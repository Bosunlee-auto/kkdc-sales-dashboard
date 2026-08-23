require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { getSalesPerformance, getQuoteSnapshotByPeriod, getBreakdownByAgencyAndAccount } = require('./lib/salesPerformance');
const { router: authRouter } = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboards');
const settingsRoutes = require('./routes/settings');

const app = express();
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'kkdc-dashboard-dev-secret-change-in-railway-env',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 12 * 60 * 60 * 1000 } // 12h - re-login once a day is fine for internal staff
  })
);
app.use(express.static('public'));

// Login / logout / session-check - backed by the Dashboard_Access CRM module
app.use('/api/auth', authRouter);

// NY Sales / NJ Sales / Total Sales / Total Invoice - each gated by
// Allowed_Dashboards from the logged-in user's CRM record
app.use('/api/dashboard', dashboardRoutes);

// BEP (Break Even Point) and Sales Quota - editable from the dashboard UI,
// persisted to the Dashboard_Settings CRM module
app.use('/api/settings', settingsRoutes);

// Main dashboard data endpoint
// GET /api/sales-performance?from=2020-01-01&to=2026-12-31&granularity=month
app.get('/api/sales-performance', async (req, res) => {
  try {
    const from = req.query.from || '2020-01-01';
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const granularity = req.query.granularity || 'month';

    const data = await getSalesPerformance(from, to, granularity);
    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// YoY comparison endpoint - same window, one year prior
// GET /api/sales-performance/yoy?from=2026-01-01&to=2026-08-06&granularity=month
app.get('/api/sales-performance/yoy', async (req, res) => {
  try {
    const from = req.query.from;
    const to = req.query.to;
    const granularity = req.query.granularity || 'month';
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to are required, e.g. 2026-01-01 / 2026-08-06' });
    }

    const priorFrom = shiftYear(from, -1);
    const priorTo = shiftYear(to, -1);

    const [current, prior] = await Promise.all([
      getSalesPerformance(from, to, granularity),
      getSalesPerformance(priorFrom, priorTo, granularity)
    ]);

    res.json({ current, prior, priorFrom, priorTo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Breakdown by agency and account for a date range
// GET /api/sales-performance/breakdown?from=2026-03-01&to=2026-03-31
app.get('/api/sales-performance/breakdown', async (req, res) => {
  try {
    const from = req.query.from;
    const to = req.query.to;
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to are required' });
    }
    const data = await getBreakdownByAgencyAndAccount(from, to);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint - verifies env vars are loaded without exposing full secrets
// Matches the /api/debug pattern used in the NJ Inventory Portal
app.get('/api/debug', (req, res) => {
  const mask = (v) => (v ? `${v.slice(0, 4)}...${v.slice(-4)}` : 'MISSING');
  res.json({
    ZOHO_CLIENT_ID: mask(process.env.ZOHO_CLIENT_ID),
    ZOHO_CLIENT_SECRET: mask(process.env.ZOHO_CLIENT_SECRET),
    ZOHO_REFRESH_TOKEN: mask(process.env.ZOHO_REFRESH_TOKEN)
  });
});

function shiftYear(isoDate, years) {
  const d = new Date(isoDate);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KKDC Sales Performance dashboard running on port ${PORT}`));
