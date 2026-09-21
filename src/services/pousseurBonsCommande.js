// Reconstruit les bons de commande dans Manoeuvre à partir des données LISIBLES.
//
// La table COMMAN (en-têtes de commande, avec le montant engagé réel) est CHIFFRÉE par
// Avantage — illisible en direct, comme CONTRA et FACTMA. On reconstruit donc chaque BC
// à partir de ce qu'on sait de source sûre :
//   - le numéro de commande porté EN CLAIR par les factures fournisseurs (PYBBIL) ;
//   - le fournisseur (nom sur la facture) ;
//   - la division, via COMITE (commande → activité), déjà résolue dans code_division ;
//   - le facturé à ce jour = somme des factures de la commande.
//
// Le « montant engagé » réel (Total PO) vit dans COMMAN chiffrée : on le laisse égal au
// facturé (meilleure valeur connue) jusqu'à un éventuel import Excel de COMMAN. C'est
// signalé par source_bc = 'avantage-transactions'.
//
// LECTURE SEULE côté Avantage. Écriture différentielle côté Manoeuvre.

const { apiGetAll, upsert, idOf, inchange, sleep } = require('../writers/base44-writer');
const { trouverProjet } = require('./pousseurTransactions');

const CHAMPS_BC = ['numero_po', 'description', 'fournisseur_avantage', 'controle_budgetaire_id',
  'montant_prevu', 'montant_facture', 'statut_avantage', 'source_bc', 'projet_id'];

// Regroupe les factures fournisseurs d'un projet par numéro de commande.
function regrouperParCommande(payloads) {
  const parCmd = new Map();
  for (const p of payloads) {
    if (p.type_transaction !== 'P') continue;
    const cmd = (p.numero_commande_avantage || '').trim();
    if (!cmd || cmd === '000000000') continue;
    let a = parCmd.get(cmd);
    if (!a) { a = { commande: cmd, fournisseur: p.fournisseur || '', code_division: p.code_division || '', montant_facture: 0 }; parCmd.set(cmd, a); }
    a.montant_facture += Number(p.montant) || 0;
    if (!a.fournisseur && p.fournisseur) a.fournisseur = p.fournisseur;
    if (!a.code_division && p.code_division) a.code_division = p.code_division;
  }
  return parCmd;
}

// Pousse les bons de commande d'un projet. payloads = transactions du projet (syncAvantage).
async function pousserBonsProjet(code, payloads, ctx) {
  const projet = trouverProjet(ctx.projets, code);
  if (!projet) return { ok: false, projet: code, error: 'Projet ' + code + ' absent de Manoeuvre' };
  const projetId = idOf(projet);

  const divMap = {};
  ctx.divisions.filter(x => x.projet_id === projetId).forEach(x => { if (x.code_division) divMap[x.code_division] = idOf(x); });

  const existingMap = {};
  (ctx.bcs || []).filter(x => x.projet_id === projetId).forEach(x => {
    if (x.reference_avantage) existingMap[String(x.reference_avantage).padStart(9, '0')] = x;
  });

  const parCmd = regrouperParCommande(payloads);
  let created = 0, updated = 0, unchanged = 0, errors = 0;

  for (const a of parCmd.values()) {
    const ref = String(a.commande).padStart(9, '0');
    const montant = Math.round(a.montant_facture * 100) / 100;
    const payload = {
      projet_id: projetId,
      reference_avantage: ref,
      numero_po: 'AV-' + ref,
      description: a.fournisseur || ('Commande ' + ref),
      fournisseur_avantage: a.fournisseur || '',
      controle_budgetaire_id: a.code_division ? (divMap[a.code_division] || null) : null,
      // Total PO inconnu (COMMAN chiffrée) : on prend le facturé comme meilleure valeur connue.
      montant_prevu: montant,
      montant_facture: montant,
      statut_avantage: 'reconstruit',
      source_bc: 'avantage-transactions',
    };
    const existant = existingMap[ref];
    if (inchange(existant, payload, CHAMPS_BC)) { unchanged++; continue; }
    payload.sync_avantage_ts = new Date().toISOString();
    const r = await upsert('BonDeCommande', existant ? idOf(existant) : null, payload);
    if (r.ok) { existant ? updated++ : created++; } else errors++;
    await sleep(50);
  }

  return { ok: true, projet: code, projet_id: projetId, total: parCmd.size, created, updated, unchanged, errors };
}

module.exports = { pousserBonsProjet, regrouperParCommande };
