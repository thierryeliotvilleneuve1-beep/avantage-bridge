const express = require('express');
const router = express.Router();
const { loadDataset } = require('../services/dataset');
const { loadSnapshot } = require('../services/snapshot');
const { syncBudget } = require('../services/syncBudget');
const { convertXlsx } = require('../services/convert');

router.post('/sync/:code', async (req, res) => {
  try {
    convertXlsx(false);
    const ds = loadDataset();
    const snap = await loadSnapshot(['Projet', 'ControleBudgetaire']);
    const r = await syncBudget(req.params.code, ds, snap);
    delete r.divMap;
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
