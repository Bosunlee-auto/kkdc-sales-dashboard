// routes/settings.js
const express = require('express');
const router = express.Router();
const { getSettingsForYear, getAllSettings, updateSettingsForYear, EARLIEST_YEAR } = require('../lib/dashboardSettings');

// GET /api/settings?year=2026  -> one year's BEP/Quota
// GET /api/settings            -> defaults to the current calendar year
router.get('/', async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
    const settings = await getSettingsForYear(year);
    res.json(settings);
  } catch (err) {
    console.error('get settings error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/all -> every year on file (2023-present), keyed by year.
// Used to populate the year-selector dropdown and the cumulative
// (2023-present) track record widget without N separate requests.
router.get('/all', async (req, res) => {
  try {
    const all = await getAllSettings();
    res.json({ earliestYear: EARLIEST_YEAR, years: all });
  } catch (err) {
    console.error('get all settings error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings  body: { year, nj: {bepAnnual, quotaAnnual}, ny: {...} }
// Updates ONLY that one year's record - other years are never touched.
router.put('/', async (req, res) => {
  try {
    const { year, nj, ny } = req.body || {};
    if (!year || !nj || !ny) {
      return res.status(400).json({ error: 'Body must include { year, nj: {bepAnnual, quotaAnnual}, ny: {...} }' });
    }
    const updated = await updateSettingsForYear({ year, nj, ny });
    res.json(updated);
  } catch (err) {
    console.error('update settings error', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
