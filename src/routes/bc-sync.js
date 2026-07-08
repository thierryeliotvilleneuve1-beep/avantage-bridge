const express = require('express');
const router = express.Router();
const { api, sleep } = require('../writers/base44-writer');
const { lireTable } = require('../datasources/avantage');

// P26010, 26010, 0000026010 → "26010" (comparaison stricte)
function normaliserCode(c) {
  return String(c || '').toUpperCase().trim().replace(/^P/, '').replace(/^0+/, '');
}

router.post('/sync-bc/:code', async (req, res) => {
  const code = req.params.code.replace(/^P/i, '').trim();
  const paddedCode = code.padStart(10, '0');

  const commanRows = (await lireTable('COMMAN')).objets;
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
  // Match STRICT (includes() pouvait rattacher le mauvais projet)
  const projet = projets.find(p => normaliserCode(p.code_projet) === normaliserCode(code));
  if (!projet) return res.json({ error: 'Projet ' + code + ' non trouvé dans Base44' });
  const projetId = projet._id || projet.id;

  const bcRes = await api('GET', '/entities/BonDeCommande?projet_id=' + encodeURIComponent(projetId) + '&limit=1000');
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

module.exports = router;