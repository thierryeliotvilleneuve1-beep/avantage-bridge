// Synchronisation des transactions Avantage → Manoeuvre.
// Lit la base .DBF en direct (via syncAvantage → donneesAvantage), avec repli CSV.

const express = require('express');
const router = express.Router();
const syncAvantage = require('../sources/syncAvantage');
const { chargerContexte, pousserProjet } = require('../services/pousseurTransactions');

// Un projet : POST /api/trans/sync-trans/:code
router.post('/sync-trans/:code', async (req, res) => {
  try {
    await syncAvantage.preparer();
    const parProjet = await syncAvantage.chargerTransactionsParProjet();
    let payloads = syncAvantage.transactionsDe(parProjet, req.params.code);

    if (req.query.division) payloads = payloads.filter(p => p.code_division === req.query.division);

    const ctx = await chargerContexte();
    const r = await pousserProjet(req.params.code.replace(/^P/i, '').trim(), payloads, ctx);
    res.json(Object.assign({ source: syncAvantage.provenance() }, r,
      { division: req.query.division || 'toutes' }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
