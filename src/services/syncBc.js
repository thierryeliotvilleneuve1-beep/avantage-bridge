const { upsert, idOf, sleep } = require('../writers/base44-writer');
const { rowsFor } = require('./dataset');
const { findProjet } = require('./snapshot');

// Pousse les bons de commande Avantage vers l'entite BonDeCommande.
// Retourne bcMap (reference paddee sur 9 -> id) pour le rattachement des transactions.
async function syncBc(codeRaw, ds, snap) {
  const code = codeRaw.replace(/^P/i, '').trim();

  const projet = findProjet(snap.Projet, code);
  if (!projet) return { ok: false, projet: code, error: 'Projet ' + code + ' non trouve dans Base44' };
  const projetId = idOf(projet);

  const bcsAvantage = rowsFor(ds.index.commandes, code);

  const bcMap = {}, existingMap = {};
  snap.BonDeCommande.filter(x => x.projet_id === projetId).forEach(x => {
    if (!x.reference_avantage) return;
    existingMap[x.reference_avantage] = idOf(x);
    bcMap[String(x.reference_avantage).padStart(9, '0')] = idOf(x);
  });

  if (!bcsAvantage.length) {
    return { ok: true, projet: code, projet_id: projetId, bcs: 0, created: 0, updated: 0, errors: 0, bcMap, note: 'Aucun bon de commande pour ce projet' };
  }

  let created = 0, updated = 0, errors = 0;
  for (const bc of bcsAvantage) {
    const reference = bc.seq_commande || bc.seq;
    const payload = {
      projet_id: projetId,
      numero_po: 'AV-' + bc.seq,
      description: bc.nom_fournisseur,
      montant_prevu: bc.sous_total,
      reference_avantage: reference,
      fournisseur_avantage: bc.no_fournisseur,
      statut_avantage: String(bc.statut) === '0' ? 'ouvert' : 'ferme',
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
