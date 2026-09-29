const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { api, sleep } = require('../writers/base44-writer');

const EXPORT_DIR = path.resolve(__dirname, '../../exports-avantage');

function readComman() {
  const xlsxPath = path.join(EXPORT_DIR, 'export.xlsx');
  if (!fs.existsSync(xlsxPath)) return [];
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets['COMMAN'];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

router.post('/sync-bc/:code', async (req, res) => {
  const code = req.params.code.replace(/^P/i, '').trim();
  const paddedCode = code.padStart(10, '0');

  const commanRows = readComman();
  const bcsAvantage = commanRows.filter(r => {
    const keys = Object.keys(r);
    const kProjet = keys.find(k => k.toLowerCase().includes('projet'));
    const np = (r[kProjet] || '').toString().trim();
    return np === paddedCode || parseInt(np, 10) === parseInt(code, 10);
  });

  if (!bcsAvantage.length) {
    return res.json({ error: 'Aucun BC trouvé dans COMMAN pour projet ' + code });
  }

  const pRes = await api('GET', '/entities/Projet?limit=500');
  let projets = [];
  try { const d = JSON.parse(pRes.data); projets = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const projet = projets.find(p => {
    const cp = (p.code_projet || '').toUpperCase();
    return cp === 'P' + code || cp.includes(code) || cp === code;
  });
  if (!projet) return res.json({ error: 'Projet ' + code + ' non trouvé dans Base44' });
  const projetId = projet._id || projet.id;

  const bcRes = await api('GET', '/entities/BonDeCommande?limit=500');
  let existing = [];
  try { const d = JSON.parse(bcRes.data); existing = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const existingMap = {};
  existing.filter(x => x.projet_id === projetId).forEach(x => {
    if (x.reference_avantage) existingMap[x.reference_avantage] = x._id || x.id;
  });

  let created = 0, updated = 0, errors = 0;

  for (const bc of bcsAvantage) {
    const keys = Object.keys(bc);
    const kSeq = keys.find(k => k.includes('quentiel') && !k.includes('commande'));
    const kSeqCommande = keys.find(k => k.includes('quentiel') && k.includes('commande'));
    const kFournisseur = keys.find(k => k.includes('fournisseur') && k.toLowerCase().includes('num'));
    const kNomFournisseur = keys.find(k => k.toLowerCase() === 'nom du fournisseur');
    const kMontant = keys.find(k => k.toLowerCase().includes('sous-total'));
    const kDate = keys.find(k => k.toLowerCase().includes('ception'));
    const kStatut = keys.find(k => k.toLowerCase().includes('statut'));

    const numSeq = (bc[kSeq] || '').toString().trim();
    const numSeqCommande = (bc[kSeqCommande] || '').toString().trim();
    const fournisseur = (bc[kFournisseur] || '').trim();
    const nomFournisseur = (bc[kNomFournisseur] || fournisseur).trim();
    const montant = parseFloat(bc[kMontant]) || 0;
    const dateCommande = (bc[kDate] || '').replace(/\//g, '-');
    const statut = (bc[kStatut] || '').toString() === '0' ? 'ouvert' : 'ferme';

    const payload = {
      projet_id: projetId,
      numero_po: 'AV-' + numSeq,
      description: nomFournisseur,
      montant_prevu: montant,
      reference_avantage: numSeqCommande || numSeq,
      fournisseur_avantage: fournisseur,
      statut_avantage: statut,
      sync_avantage_ts: new Date().toISOString(),
    };

    const existingId = existingMap[numSeqCommande || numSeq];
    let st = 429;
    while (st === 429) {
      const r = existingId
        ? await api('PUT', '/entities/BonDeCommande/' + existingId, payload)
        : await api('POST', '/entities/BonDeCommande', payload);
      st = r.status;
      if (st === 429) await sleep(1500);
    }
    if (st === 200 || st === 201) { existingId ? updated++ : created++; } else errors++;
    await sleep(100);
  }

  res.json({ ok: true, projet: code, bcs: bcsAvantage.length, created, updated, errors });
});

// ── FLUX INVERSE : BC Manœuvre → Avantage (Voie A, semi-automatique) ─────────
const bcVersAvantage = require('../services/bcVersAvantage');

// Liste des BC validés en attente de saisie dans Avantage (JSON).
router.get('/a-saisir', async (req, res) => {
  try { res.json(await bcVersAvantage.listerASaisir()); }
  catch (e) { res.status(500).json({ ok: false, erreur: e.message }); }
});

// Fiches de saisie imprimables (HTML) — toutes les BC en attente. Ouvrir dans un navigateur
// avec ?key=… puis imprimer. Une fiche = une commande à saisir dans Avantage.
router.get('/fiches', async (req, res) => {
  try {
    const { bcs } = await bcVersAvantage.listerASaisir();
    res.set('Content-Type', 'text/html; charset=utf-8').send(bcVersAvantage.fichesHTML(bcs));
  } catch (e) { res.status(500).json({ ok: false, erreur: e.message }); }
});

// Fiche de saisie d'UN seul BC (par id Manœuvre), en HTML.
router.get('/fiche/:id', async (req, res) => {
  try {
    const { bcs } = await bcVersAvantage.listerASaisir();
    const b = bcs.find(x => x.id === req.params.id);
    if (!b) return res.status(404).json({ ok: false, erreur: 'BC introuvable ou déjà saisi/confirmé' });
    res.set('Content-Type', 'text/html; charset=utf-8').send(bcVersAvantage.fichesHTML([b]));
  } catch (e) { res.status(500).json({ ok: false, erreur: e.message }); }
});

// Réconciliation BC Manœuvre ↔ COMMAN Avantage. Dry-run par défaut ; ?apply=true pour écrire
// le n° Avantage + « Confirmé Avantage » dans Manœuvre. Alerte Teams sur écarts/retards.
router.post('/reconcilier', async (req, res) => {
  const apply = req.query.apply === 'true' || req.query.apply === '1';
  try { res.json(await bcVersAvantage.reconcilier(null, { dryRun: !apply })); }
  catch (e) { res.status(500).json({ ok: false, erreur: e.message }); }
});

module.exports = router;