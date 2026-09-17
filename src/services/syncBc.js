const { upsert, idOf, sleep } = require('../writers/base44-writer');
const { rowsFor } = require('./dataset');
const { findProjet } = require('./snapshot');

// Pousse les bons de commande Avantage (onglet COMMAN) vers l'entite BonDeCommande.
// Retourne bcMap (reference padde 9 -> id) pour le rattachement des transactions.
async function syncBc(codeRaw, ds, snap) {
  const code = codeRaw.replace(/^P/i, '').trim();

  const projet = findProjet(snap.Projet, code);
  if (!projet) return { ok: false, projet: code, error: 'Projet ' + code + ' non trouve dans Base44' };
  const projetId = idOf(projet);

  const bcsAvantage = rowsFor(ds.index.comman, code);

  const bcMap = {};
  snap.BonDeCommande.filter(x => x.projet_id === projetId).forEach(x => {
    if (x.reference_avantage) bcMap[String(x.reference_avantage).padStart(9, '0')] = idOf(x);
  });

  if (!bcsAvantage.length) {
    return { ok: true, projet: code, projet_id: projetId, bcs: 0, created: 0, updated: 0, errors: 0, bcMap, note: 'Aucun BC dans COMMAN' };
  }

  const existingMap = {};
  snap.BonDeCommande.filter(x => x.projet_id === projetId).forEach(x => {
    if (x.reference_avantage) existingMap[x.reference_avantage] = idOf(x);
  });

  let created = 0, updated = 0, errors = 0;
  for (const bc of bcsAvantage) {
    const keys = Object.keys(bc);
    const kSeq = keys.find(k => k.includes('quentiel') && !k.includes('commande'));
    const kSeqCommande = keys.find(k => k.includes('quentiel') && k.includes('commande'));
    const kFournisseur = keys.find(k => k.includes('fournisseur') && k.toLowerCase().includes('num'));
    const kNomFournisseur = keys.find(k => k.toLowerCase() === 'nom du fournisseur');
    const kMontant = keys.find(k => k.toLowerCase().includes('sous-total'));
    const kStatut = keys.find(k => k.toLowerCase().includes('statut'));

    const numSeq = (bc[kSeq] || '').toString().trim();
    const numSeqCommande = (bc[kSeqCommande] || '').toString().trim();
    const fournisseur = (bc[kFournisseur] || '').toString().trim();
    const nomFournisseur = (bc[kNomFournisseur] || fournisseur).toString().trim();
    const montant = parseFloat(bc[kMontant]) || 0;
    const statut = (bc[kStatut] || '').toString() === '0' ? 'ouvert' : 'ferme';
    const reference = numSeqCommande || numSeq;

    const payload = {
      projet_id: projetId,
      numero_po: 'AV-' + numSeq,
      description: nomFournisseur,
      montant_prevu: montant,
      reference_avantage: reference,
      fournisseur_avantage: fournisseur,
      statut_avantage: statut,
      sync_avantage_ts: new Date().toISOString(),
    };

    const existingId = existingMap[reference];
    const r = await upsert('BonDeCommande', existingId || null, payload);
    if (r.ok) {
      if (existingId) updated++;
      else {
        created++;
        if (r.body && idOf(r.body)) {
          existingMap[reference] = idOf(r.body);
          bcMap[String(reference).padStart(9, '0')] = idOf(r.body);
        }
      }
    } else errors++;
    await sleep(100);
  }

  return { ok: true, projet: code, projet_id: projetId, bcs: bcsAvantage.length, created, updated, errors, bcMap };
}

module.exports = { syncBc };
