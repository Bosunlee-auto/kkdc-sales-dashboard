// lib/dashboardSettings.js
// Break Even Point (BEP) and Sales Quota, per office, PER YEAR - stored as
// one Dashboard_Settings CRM record per year (Year field, e.g. 2023-2026).
//
// CHANGED 2026-08-25 (per Bosun): previously a single mutable record - if
// you changed the value to peek at a prior year, it silently overwrote the
// number the CURRENT year's progress bar depends on. BEP/Quota are annual
// targets that legitimately differ year to year, and Bosun wants a
// permanent, never-overwritten record per year (starting 2023) to support
// year-over-year and cumulative (2023-present) track record reporting.
// Each year now gets its own record (Name = "FY{year}", Year = {year}); a
// past year's numbers are never touched by editing another year's.

const { coqlQuery, getAccessToken } = require('./zoho');
const fetch = require('node-fetch');

const EARLIEST_YEAR = 2023; // per Bosun: cumulative tracking starts here, not before
let cache = null; // { [year]: settings }
let cacheAt = 0;
const CACHE_TTL_MS = 60 * 1000; // short cache - these change rarely but should reflect quickly after a save

function emptySettings(year) {
  return {
    id: null,
    year,
    nj: { bepAnnual: 0, quotaAnnual: 0 },
    ny: { bepAnnual: 0, quotaAnnual: 0 }
  };
}

async function loadAll() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;

  const rows = await coqlQuery(
    `select id, Year, NJ_BEP_Annual, NY_BEP_Annual, NJ_Quota_Annual, NY_Quota_Annual from Dashboard_Settings where Year >= ${EARLIEST_YEAR}`
  );
  const byYear = {};
  for (const row of rows) {
    if (!row.Year) continue; // skip any legacy record that never got a Year assigned
    byYear[row.Year] = {
      id: row.id,
      year: row.Year,
      nj: { bepAnnual: Number(row.NJ_BEP_Annual || 0), quotaAnnual: Number(row.NJ_Quota_Annual || 0) },
      ny: { bepAnnual: Number(row.NY_BEP_Annual || 0), quotaAnnual: Number(row.NY_Quota_Annual || 0) }
    };
  }
  cache = byYear;
  cacheAt = now;
  return byYear;
}

/**
 * Returns { id, year, nj: {bepAnnual, quotaAnnual}, ny: {...} } for one
 * year. Returns zeroed placeholder values (id: null) if that year has no
 * record yet - the frontend should treat this as "not configured", not as
 * a real $0 target.
 */
async function getSettingsForYear(year) {
  const all = await loadAll();
  return all[year] || emptySettings(year);
}

/**
 * Returns every year's settings currently on file (2023-present), keyed by
 * year number. Used for the year-selector dropdown and the cumulative
 * (2023-present) track record widget.
 */
async function getAllSettings() {
  return loadAll();
}

/**
 * Updates (or creates) ONE year's Dashboard_Settings record. Editing one
 * year never touches any other year's record.
 * input: { year, nj: { bepAnnual, quotaAnnual }, ny: { bepAnnual, quotaAnnual } }
 */
async function updateSettingsForYear(input) {
  const year = Number(input.year);
  if (!year || year < EARLIEST_YEAR) {
    throw new Error(`year must be a number >= ${EARLIEST_YEAR}`);
  }
  const current = await getSettingsForYear(year);
  const token = await getAccessToken();

  const payload = {
    Name: `FY${year}`,
    Year: year,
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

  cache = null; // force reload of all years on next call
  return getSettingsForYear(year);
}

module.exports = { getSettingsForYear, getAllSettings, updateSettingsForYear, EARLIEST_YEAR };
