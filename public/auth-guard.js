// public/auth-guard.js
// Included at the top of every dashboard page. Checks the session against
// the Dashboard_Access CRM module (via /api/auth/session), redirects to
// login if not authenticated, and renders a nav bar showing only the
// dashboards this user is allowed to see.
//
// Each dashboard page sets <body data-dashboard="NY|NJ|TOTAL_SALES|TOTAL_INVOICE">
// so this script can block access even if someone guesses/bookmarks a URL
// they aren't permissioned for.

(function () {
  const DASHBOARD_LABELS = {
    NY: 'NY Sales',
    NJ: 'NJ Sales',
    TOTAL_SALES: 'Total Sales',
    TOTAL_INVOICE: 'Total Invoice'
  };
  const DASHBOARD_URLS = {
    NY: '/ny-sales.html',
    NJ: '/nj-sales.html',
    TOTAL_SALES: '/index.html',
    TOTAL_INVOICE: '/total-invoice.html'
  };

  async function guard() {
    const res = await fetch('/api/auth/session');
    const session = await res.json();

    if (!session.loggedIn) {
      window.location.href = '/login.html?next=' + encodeURIComponent(window.location.pathname);
      return;
    }

    renderNav(session);

    const required = document.body.getAttribute('data-dashboard');
    if (required && !session.allowedDashboards.includes(required)) {
      document.body.innerHTML =
        '<div style="padding:60px;text-align:center;font-family:sans-serif;color:#6b7280;">' +
        '<h2 style="color:#1a1d1f;">Not authorized</h2>' +
        '<p>Your account does not have access to this dashboard. Contact Bosun to update your access in CRM.</p>' +
        '<a href="/index.html">Go to a dashboard you have access to</a>' +
        '</div>';
      throw new Error('unauthorized'); // stop the page's own dashboard script from running
    }
  }

  function renderNav(session) {
    const bar = document.createElement('div');
    bar.style.cssText =
      'display:flex;align-items:center;gap:16px;padding:10px 20px;background:#1a1d1f;color:#fff;' +
      'font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:13px;margin:-24px -24px 24px -24px;';

    const links = session.allowedDashboards
      .filter((key) => DASHBOARD_URLS[key])
      .map((key) => {
        const isCurrent = document.body.getAttribute('data-dashboard') === key;
        return `<a href="${DASHBOARD_URLS[key]}" style="color:${isCurrent ? '#fff' : '#9ca3af'};text-decoration:none;font-weight:${isCurrent ? '600' : '400'};">${DASHBOARD_LABELS[key]}</a>`;
      })
      .join('');

    bar.innerHTML =
      `<strong style="margin-right:8px;">KKDC</strong>${links}` +
      `<span style="margin-left:auto;color:#9ca3af;">${session.name}</span>` +
      `<button id="logoutBtn" style="background:none;border:1px solid #4b5563;color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;">Log out</button>`;

    document.body.prepend(bar);
    document.getElementById('logoutBtn').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });
  }

  // Run immediately - dashboard pages should await this before fetching data.
  window.__authGuardReady = guard();
})();
