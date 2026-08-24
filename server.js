require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { getSalesPerformance, getQuoteSnapshotByPeriod, getBreakdownByAgencyAndAccount } = require('./lib/salesPerformance');
const { router: authRouter, requireDashboard } = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboards');
const settingsRoutes = require('./routes/settings');

const app = express();
// Railway sits behind a proxy that terminates HTTPS - without this, Express
// sees the connection as plain HTTP and silently refuses to set
// "secure" cookies, which is exactly what broke login inside the CRM Web
// Tab iframe (2026-08-24: login succeeded, but the very next request came
// back "not logged in" because the cookie was never actually stored).
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());
// NOTE (2026-08-24): express-session removed. Login state now lives in a
// signed JWT cookie (see routes/auth.js) instead of server memory, so a
// Railway redeploy no longer logs everyone out - only the cookie's own
// ~6-month expiry or an explicit logout ends a session.
app.use(express.static('public'));

// Login / logout / session-check - backed by the Dashboard_Access CRM module
app.use('/api/auth', authRouter);

// NY Sales / NJ Sales / Total Sales / Total Invoice - each gated by
// Allowed_Dashboards from the logged-in user's CRM record
app.use('/api/dashboard', dashboardRoutes);

// BEP (Break Even Point) and Sales Quota - editable from the dashboard UI,
// persisted to the Dashboard_Settings CRM module
app.use('/api/settings', settingsRoutes);

// /api/sales-performance* is shared by Total Sales, NY Sales, and NJ Sales
// (2026-08-23: "Total sales, NJ and NY sales should be all in the same
// format" - same endpoints, same response shape, scoped by ?office=NY|NJ).
// Previously these routes had NO authorization check at all - fixed here by
// mapping the requested office to the matching Allowed_Dashboards key.
function requireSalesDashboard(req, res, next) {
  const office = req.query.office;
  const key = office === 'NY' ? 'NY' : office === 'NJ' ? 'NJ' : 'TOTAL_SALES';
  return requireDashboard(key)(req, res, next);
}
function normalizeOffice(office) {
  return office === 'NY' || office === 'NJ' ? office : null;
}

// Main dashboard data endpoint
// GET /api/sales-performance?from=2020-01-01&to=2026-12-31&granularity=month&office=NY
app.get('/api/sales-performance', requireSalesDashboard, async (req, res) => {
  try {
    const from = req.query.from || `${new Date().getFullYear()}-01-01`;
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const granularity = req.query.granularity || 'month';
    const office = normalizeOffice(req.query.office);

    const data = await getSalesPerformance(from, to, granularity, office);
    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// YoY comparison endpoint - same window, one year prior
// GET /api/sales-performance/yoy?from=2026-01-01&to=2026-08-06&granularity=month&office=NJ
app.get('/api/sales-performance/yoy', requireSalesDashboard, async (req, res) => {
  try {
    const from = req.query.from;
    const to = req.query.to;
    const granularity = req.query.granularity || 'month';
    const office = normalizeOffice(req.query.office);
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to are required, e.g. 2026-01-01 / 2026-08-06' });
    }

    const priorFrom = shiftYear(from, -1);
    const priorTo = shiftYear(to, -1);

    const [current, prior] = await Promise.all([
      getSalesPerformance(from, to, granularity, office),
      getSalesPerformance(priorFrom, priorTo, granularity, office)
    ]);

    res.json({ current, prior, priorFrom, priorTo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Breakdown by agency, account, and customer for a date range
// GET /api/sales-performance/breakdown?from=2026-03-01&to=2026-03-31&office=NY
app.get('/api/sales-performance/breakdown', requireSalesDashboard, async (req, res) => {
  try {
    const from = req.query.from;
    const to = req.query.to;
    const office = normalizeOffice(req.query.office);
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to are required' });
    }
    const data = await getBreakdownByAgencyAndAccount(from, to, office);
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
