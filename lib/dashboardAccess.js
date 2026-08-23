// lib/dashboardAccess.js
// Authenticates against the Dashboard_Access custom module in Zoho CRM.
// Bosun manages users directly in CRM UI (Name / PIN_Code / Allowed_Dashboards /
// Active) - no redeploy needed to add, remove, or re-permission a user.
//
// Allowed_Dashboards is a comma-separated text field (not a true multiselect
// picklist - the Zoho module-builder API used to create it doesn't support
// setting picklist option values), e.g. "NY,NJ,TOTAL_SALES,TOTAL_INVOICE".
// Valid tokens: NY, NJ, TOTAL_SALES, TOTAL_INVOICE.

const { coqlQuery } = require('./zoho');

// Short cache so a login burst doesn't hammer Zoho, but changes in CRM
// (e.g. Bosun deactivating a user) take effect within a few minutes.
let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 2 * 60 * 1000;

async function loadUsers() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;

  const rows = await coqlQuery(
    `select Name, PIN_Code, Allowed_Dashboards, Active from Dashboard_Access where Active = true`
  );
  cache = rows;
  cacheAt = now;
  return rows;
}

/**
 * Validates loginId + pin against CRM. Returns { name, allowedDashboards: string[] }
 * on success, or null on failure. Case-insensitive on login id.
 */
async function authenticate(loginId, pin) {
  if (!loginId || !pin) return null;
  const users = await loadUsers();
  const match = users.find(
    (u) => (u.Name || '').trim().toLowerCase() === String(loginId).trim().toLowerCase()
  );
  if (!match) return null;
  if (String(match.PIN_Code || '') !== String(pin)) return null;

  const allowedDashboards = (match.Allowed_Dashboards || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  return { name: match.Name, allowedDashboards };
}

function invalidateCache() {
  cache = null;
  cacheAt = 0;
}

module.exports = { authenticate, invalidateCache };
