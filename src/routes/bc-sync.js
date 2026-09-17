const express = require('express');
const router = express.Router();
const { loadDataset } = require('../services/dataset');
const { loadSnapshot } = require('../services/snapshot');
const { syncBc } = require('../services/syncBc');
const { convertXlsx } = require('../services/convert');

router.post('/sync-bc/:code', async (req, res) => {
  try {
    convertXlsx(false);
    const ds = loadDataset();
    const snap = await loadSnapshot(['Projet', 'BonDeCommande']);
    const r = await syncBc(req.params.code, ds, snap);
    delete r.bcMap;
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
