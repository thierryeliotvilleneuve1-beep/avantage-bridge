// Pousse les paiements fournisseurs dans Manoeuvre (entité PaiementFournisseur), lus dans
// PYBACM (lisible). Chaque paiement est rattaché à sa transaction via le n° de facture :
// le préfixe de PANOPAI (« ######-NN ») correspond au numero_journal 'P######' de la
// transaction. On ne crée un paiement que pour les transactions déjà présentes dans
// Manoeuvre, ce qui borne le volume au périmètre synchronisé.
//
// LECTURE SEULE côté Avantage. Écriture différentielle côté Manoeuvre.

const { upsert, idOf, inchange, sleep } = require('../writers/base44-writer');
const depotDbf = require('../sources/depotDbf');
const { trouverProjet } = require('./pousseurTransactions');

const CHAMPS = ['projet_id', 'transaction_id', 'bon_de_commande_id', 'numero_paiement',
  'date_paiement', 'montant_paiement', 'reference_cheque'];

let cache = null;

// Table facture_seq (préfixe PANOPAI) → [paiements], lue une fois par cycle.
function chargerPaiements() {
  if (cache) return cache;
  const parFacture = new Map();
  try {
    if (depotDbf.disponible() && depotDbf.aTable('PYBACM')) {
      for (const p of depotDbf.lirePaiements()) {
        if (!parFacture.has(p.facture_seq)) parFacture.set(p.facture_seq, []);
        parFacture.get(p.facture_seq).push(p);
      }
    }
  } catch (e) { /* table absente ou illisible : aucun paiement */ }
  cache = parFacture;
  return parFacture;
}

function reset() { cache = null; }

// Pousse les paiements d'un projet. ctx.transactions doit être RECHARGÉ après l'écriture
// des transactions (on a besoin de leur _id Manoeuvre pour transaction_id).
async function pousserPaiementsProjet(code, ctx) {
  const projet = trouverProjet(ctx.projets, code);
  if (!projet) return { ok: false, projet: code, error: 'Projet ' + code + ' absent de Manoeuvre' };
  const projetId = idOf(projet);

  const parFacture = chargerPaiements();
  if (!parFacture.size) return { ok: true, projet: code, total: 0, created: 0, updated: 0, unchanged: 0, errors: 0 };

  const txProjet = (ctx.transactions || []).filter(x => x.projet_id === projetId && x.numero_journal);
  const existMap = {};
  (ctx.paiements || []).forEach(x => { if (x.reference_paiement) existMap[x.reference_paiement] = x; });

  let created = 0, updated = 0, unchanged = 0, errors = 0, total = 0;
  for (const tx of txProjet) {
    const seq = parseInt(String(tx.numero_journal).replace(/^P/i, ''), 10);
    if (!Number.isFinite(seq)) continue;
    const pais = parFacture.get(seq);
    if (!pais) continue;
    for (const p of pais) {
      total++;
      const payload = {
        projet_id: projetId,
        transaction_id: idOf(tx),
        bon_de_commande_id: tx.bon_de_commande_id || null,
        reference_paiement: p.reference_paiement,
        numero_paiement: p.numero_paiement,
        date_paiement: p.date_paiement,
        montant_paiement: p.montant_paiement,
        reference_cheque: p.reference_cheque,
      };
      const ex = existMap[p.reference_paiement];
      if (inchange(ex, payload, CHAMPS)) { unchanged++; continue; }
      payload.sync_avantage_ts = new Date().toISOString();
      const r = await upsert('PaiementFournisseur', ex ? idOf(ex) : null, payload);
      if (r.ok) { ex ? updated++ : created++; } else errors++;
      await sleep(50);
    }
  }
  return { ok: true, projet: code, total, created, updated, unchanged, errors };
}

module.exports = { pousserPaiementsProjet, chargerPaiements, reset };
