// routes/settings.js
const express = require('express');
const router = express.Router();
const { getSettings, updateSettings } = require('../lib/dashboardSettings');

router.get('/', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (err) {
    console.error('get settings error', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/', async (req, res) => {
  try {
    const { nj, ny } = req.body || {};
    if (!nj || !ny) {
      return res.status(400).json({ error: 'Body must include { nj: {bepAnnual, quotaAnnual}, ny: {...} }' });
    }
    const updated = await updateSettings({ nj, ny });
    res.json(updated);
  } catch (err) {
    console.error('update settings error', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
