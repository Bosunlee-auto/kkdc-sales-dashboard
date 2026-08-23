// lib/dashboardSettings.js
// Break Even Point (BEP) and Sales Quota, per office, stored as annual
// figures in the "Dashboard_Settings" CRM custom module (single record,
// Name = 'default'). Bosun edits these directly from the dashboard UI - the
// UI calls PUT /api/settings, which writes straight to this CRM record.
// No redeploy needed to change a number.

const { coqlQuery, getAccessToken } = require('./zoho');
const fetch = require('node-fetch');

const RECORD_NAME = 'default';
let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60 * 1000; // short cache - these change rarely but should reflect quickly after a save

async function getSettings() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;

  const rows = await coqlQuery(
    `select id, NJ_BEP_Annual, NY_BEP_Annual, NJ_Quota_Annual, NY_Quota_Annual from Dashboard_Settings where Name = '${RECORD_NAME}'`
  );
  const row = rows[0] || {};
  const settings = {
    id: row.id || null,
    nj: { bepAnnual: Number(row.NJ_BEP_Annual || 0), quotaAnnual: Number(row.NJ_Quota_Annual || 0) },
    ny: { bepAnnual: Number(row.NY_BEP_Annual || 0), quotaAnnual: Number(row.NY_Quota_Annual || 0) }
  };
  cache = settings;
  cacheAt = now;
  return settings;
}

/**
 * Updates the single Dashboard_Settings record. Expects
 * { nj: { bepAnnual, quotaAnnual }, ny: { bepAnnual, quotaAnnual } }.
 * Creates the record if it doesn't exist yet (shouldn't normally happen -
 * seeded once during setup - but handled defensively).
 */
async function updateSettings(input) {
  const current = await getSettings();
  const token = await getAccessToken();

  const payload = {
    Name: RECORD_NAME,
    NJ_BEP_Annual: Number(input.nj.bepAnnual),
    NY_BEP_Annual: Number(input.ny.bepAnnual),
    NJ_Quota_Annual: Number(input.nj.quotaAnnual),
    NY_Quota_Annual: Number(input.ny.quotaAnnual)
  };

  const url = current.id
    ? `https://www.zohoapis.com/crm/v6/Dashboard_Settings/${current.id}`
    : `https://www.zohoapis.com/crm/v6/Dashboard_Settings`;
  const method = current.id ? 'PUT' : 'POST';

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ data: [payload] })
  });
  const data = await res.json();
  if (data.status === 'error' || (data.data && data.data[0] && data.data[0].status === 'error')) {
    throw new Error('Failed to save settings: ' + JSON.stringify(data));
  }

  cache = null; // force reload on next getSettings() call
  return getSettings();
}

module.exports = { getSettings, updateSettings };
