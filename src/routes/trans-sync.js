const express = require('express');
const router = express.Router();
const { avecSource } = require('../sources');
const { buildDataset } = require('../services/dataset');
const { loadSnapshot } = require('../services/snapshot');
const { syncTrans } = require('../services/syncTrans');

router.post('/sync-trans/:code', async (req, res) => {
  try {
    const code = req.params.code;
    await avecSource(s => s.prepare(false));
    const ds = buildDataset(await avecSource(s => s.loadDetail([code])));
    const snap = await loadSnapshot(['Projet', 'ControleBudgetaire', 'BonDeCommande', 'TransactionAvantage']);
    const r = await syncTrans(code, ds, snap, { division: req.query.division || null });
    res.json(Object.assign({ source: ds.source }, r));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
