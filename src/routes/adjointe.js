const express = require('express');
const router = express.Router();
const runner = require('../adjointe/runner');
const { lireEtat, lireJournal } = require('../adjointe/store');
const { NIVEAUX } = require('../adjointe/policy');

// Les identifiants de message Graph peuvent contenir des caractères réservés :
// ils transitent par le corps de la requête, jamais par le chemin.
function erreur(res, e) {
  const code = e.status || 500;
  return res.status(code).json({ ok: false, erreur: e.message });
}

router.get('/statut', async (req, res) => {
  try {
    res.json({ ok: true, niveaux: NIVEAUX, ...(await runner.statut()) });
  } catch (e) { erreur(res, e); }
});

router.get('/file', (req, res) => {
  const { statut, projet, categorie } = req.query;
  const etat = lireEtat();
  let elements = Object.values(etat.elements || {});
  if (statut) elements = elements.filter((e) => e.statut === statut);
  if (projet) elements = elements.filter((e) => e.projet === projet);
  if (categorie) elements = elements.filter((e) => e.categorie === categorie);
  elements.sort((a, b) => new Date(b.recu_le) - new Date(a.recu_le));
  res.json({ ok: true, total: elements.length, elements });
});

router.get('/journal', (req, res) => {
  res.json({ ok: true, entrees: lireJournal(parseInt(req.query.limite || '200', 10)) });
});

router.post('/cycle', async (req, res) => {
  try {
    const rapport = await runner.executerCycle({
      niveau: req.body && req.body.niveau,
      limite: (req.body && req.body.limite) || 50,
      depuis: req.body && req.body.depuis,
    });
    res.json({ ok: true, rapport });
  } catch (e) { erreur(res, e); }
});

router.post('/brouillon', async (req, res) => {
  try {
    const { id, notes } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, erreur: 'id requis' });
    res.json({ ok: true, element: await runner.preparerManuellement(id, notes) });
  } catch (e) { erreur(res, e); }
});

// Envoi — action humaine uniquement. Aucun appel automatique ne passe par ici.
router.post('/envoyer', async (req, res) => {
  try {
    const { id, corps, approuve_par } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, erreur: 'id requis' });
    res.json({ ok: true, element: await runner.approuverEtEnvoyer(id, corps, approuve_par) });
  } catch (e) { erreur(res, e); }
});

router.post('/rejeter', async (req, res) => {
  try {
    const { id, motif, par } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, erreur: 'id requis' });
    res.json({ ok: true, element: await runner.rejeter(id, motif, par) });
  } catch (e) { erreur(res, e); }
});

router.post('/traite', async (req, res) => {
  try {
    const { id, par } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, erreur: 'id requis' });
    res.json({ ok: true, element: await runner.marquerTraite(id, par) });
  } catch (e) { erreur(res, e); }
});

router.post('/vault', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, erreur: 'id requis' });
    res.json({ ok: true, resultat: await runner.consignerAuVault(id) });
  } catch (e) { erreur(res, e); }
});

module.exports = router;
