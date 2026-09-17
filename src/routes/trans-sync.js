const express = require('express');
const router = express.Router();
const { loadDataset } = require('../services/dataset');
const { loadSnapshot } = require('../services/snapshot');
const { syncTrans } = require('../services/syncTrans');
const { convertXlsx } = require('../services/convert');

router.post('/sync-trans/:code', async (req, res) => {
  try {
    convertXlsx(false);
    const ds = loadDataset();
    const snap = await loadSnapshot(['Projet', 'ControleBudgetaire', 'BonDeCommande', 'TransactionAvantage']);
    const r = await syncTrans(req.params.code, ds, snap, { division: req.query.division || null });
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
