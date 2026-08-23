// routes/auth.js
// Session-based login backed by the Dashboard_Access CRM module.
// Bosun manages who can log in and which dashboards they see entirely in
// CRM - this file just enforces whatever CRM currently says.

const express = require('express');
const router = express.Router();
const { authenticate } = require('../lib/dashboardAccess');

const VALID_DASHBOARDS = ['NY', 'NJ', 'TOTAL_SALES', 'TOTAL_INVOICE'];

router.post('/login', async (req, res) => {
  try {
    const { loginId, pin } = req.body || {};
    const user = await authenticate(loginId, pin);
    if (!user) {
      return res.status(401).json({ error: 'Invalid login ID or PIN' });
    }
    req.session.user = user;
    res.json({ ok: true, name: user.name, allowedDashboards: user.allowedDashboards });
  } catch (err) {
    console.error('login error', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/session', (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, name: req.session.user.name, allowedDashboards: req.session.user.allowedDashboards });
});

/**
 * Middleware factory - blocks access to a specific dashboard's API routes
 * unless the logged-in user's Allowed_Dashboards (from CRM) includes it.
 */
function requireDashboard(dashboardKey) {
  if (!VALID_DASHBOARDS.includes(dashboardKey)) {
    throw new Error(`Unknown dashboard key: ${dashboardKey}`);
  }
  return (req, res, next) => {
    const user = req.session.user;
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    if (!user.allowedDashboards.includes(dashboardKey)) {
      return res.status(403).json({ error: `Not authorized for ${dashboardKey}` });
    }
    next();
  };
}

module.exports = { router, requireDashboard, VALID_DASHBOARDS };
