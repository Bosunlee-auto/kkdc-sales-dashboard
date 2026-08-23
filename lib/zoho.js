const fetch = require('node-fetch');

// Zoho access tokens expire hourly - cache and refresh automatically.
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });

  const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Zoho token refresh failed: ' + JSON.stringify(data));
  }

  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in * 1000);
  return cachedToken;
}

// COQL query - single source of pagination-aware querying against Zoho CRM.
// Zoho COQL caps at 2000 rows per call; loops using LIMIT offset until exhausted.
async function coqlQuery(selectQuery, maxRows = 50000) {
  const token = await getAccessToken();
  let allRows = [];
  let offset = 0;
  const pageSize = 2000;

  while (allRows.length < maxRows) {
    const pagedQuery = `${selectQuery} LIMIT ${offset}, ${pageSize}`;
    const res = await fetch('https://www.zohoapis.com/crm/v6/coql', {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ select_query: pagedQuery })
    });

    const data = await res.json();
    if (data.status === 'error') {
      throw new Error('COQL error: ' + JSON.stringify(data));
    }

    const rows = data.data || [];
    allRows = allRows.concat(rows);

    if (!data.info || !data.info.more_records || rows.length === 0) break;
    offset += pageSize;
  }

  return allRows;
}

module.exports = { getAccessToken, coqlQuery };
