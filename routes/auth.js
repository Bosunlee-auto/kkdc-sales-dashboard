// routes/auth.js
// Stateless (JWT) login backed by the Dashboard_Access CRM module.
// Bosun manages who can log in and which dashboards they see entirely in
// CRM - this file just enforces whatever CRM currently says.
//
// CHANGED 2026-08-24 (per Bosun's request for "재배포에도 안 풀리는" login):
// Previously used express-session, which stores login state in server
// memory - every Railway redeploy wiped it, forcing everyone to log in
// again regardless of the cookie's stated expiry. Switched to a stateless
// JWT stored directly in a signed cookie: the cookie itself carries
// {name, allowedDashboards}, cryptographically signed with SESSION_SECRET.
// The server verifies the signature on each request instead of looking up
// a session store - so a redeploy (which only restarts the server process,
// not the user's browser) no longer logs anyone out. The cookie's own
// maxAge (set at login) is now the ONLY thing that ends a session, besides
// an explicit logout.

const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { authenticate } = require('../lib/dashboardAccess');

const VALID_DASHBOARDS = ['NY', 'NJ', 'TOTAL_SALES', 'TOTAL_INVOICE'];
const COOKIE_NAME = 'kkdc_session';
const TOKEN_MAX_AGE_MS = 6 * 30 * 24 * 60 * 60 * 1000; // ~6 months, matches the cookie's own maxAge below

function getSecret() {
  return process.env.SESSION_SECRET || 'kkdc-dashboard-dev-secret-change-in-railway-env';
}

function cookieOptions() {
  return {
    httpOnly: true,
    maxAge: TOKEN_MAX_AGE_MS,
    // Required for the dashboard to work inside a Zoho CRM Web Tab (iframe
    // on a different domain) - browsers drop cookies there unless marked
    // SameSite=None + Secure. Direct browser-tab usage works fine either way.
    sameSite: 'none',
    secure: true
  };
}

router.post('/login', async (req, res) => {
  try {
    const { loginId, pin } = req.body || {};
    const user = await authenticate(loginId, pin);
    if (!user) {
      return res.status(401).json({ error: 'Invalid login ID or PIN' });
    }

    const token = jwt.sign(
      { name: user.name, allowedDashboards: user.allowedDashboards },
      getSecret(),
      { expiresIn: Math.floor(TOKEN_MAX_AGE_MS / 1000) }
    );
    res.cookie(COOKIE_NAME, token, cookieOptions());
    res.json({ ok: true, name: user.name, allowedDashboards: user.allowedDashboards });
  } catch (err) {
    console.error('login error', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { sameSite: 'none', secure: true });
  res.json({ ok: true });
});

router.get('/session', (req, res) => {
  const user = verifyRequest(req);
  if (!user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, name: user.name, allowedDashboards: user.allowedDashboards });
});

/**
 * Verifies the JWT cookie on an incoming request. Returns the decoded
 * {name, allowedDashboards} payload, or null if missing/invalid/expired.
 */
function verifyRequest(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, getSecret());
  } catch (err) {
    return null; // expired or tampered - treat as logged out, don't crash the request
  }
}

/**
 * Middleware factory - blocks access to a specific dashboard's API routes
 * unless the logged-in user's Allowed_Dashboards (from CRM, baked into the
 * JWT at login time) includes it.
 */
function requireDashboard(dashboardKey) {
  if (!VALID_DASHBOARDS.includes(dashboardKey)) {
    throw new Error(`Unknown dashboard key: ${dashboardKey}`);
  }
  return (req, res, next) => {
    const user = verifyRequest(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    if (!user.allowedDashboards.includes(dashboardKey)) {
      return res.status(403).json({ error: `Not authorized for ${dashboardKey}` });
    }
    next();
  };
}

module.exports = { router, requireDashboard, VALID_DASHBOARDS, verifyRequest };
