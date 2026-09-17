const express = require('express');
const router = express.Router();
const { avecSource } = require('../sources');
const { buildDataset } = require('../services/dataset');
const { loadSnapshot } = require('../services/snapshot');
const { syncBudget } = require('../services/syncBudget');

router.post('/sync/:code', async (req, res) => {
  try {
    const code = req.params.code;
    await avecSource(s => s.prepare(false));
    const ds = buildDataset(await avecSource(s => s.loadDetail([code])));
    const snap = await loadSnapshot(['Projet', 'ControleBudgetaire']);
    const r = await syncBudget(code, ds, snap);
    delete r.divMap;
    res.json(Object.assign({ source: ds.source }, r));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
