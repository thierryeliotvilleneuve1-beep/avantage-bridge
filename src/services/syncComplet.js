// Cycle de synchronisation complet Avantage → Manoeuvre : projets, factures client,
// puis transactions par projet. Lit la base .DBF en direct (repli CSV automatique).

const syncAvantage = require('../sources/syncAvantage');
const { writeProjets, writeFactures } = require('../writers/base44-writer');
const { chargerContexte, pousserProjet } = require('./pousseurTransactions');
const { normaliserProjet } = require('../parsers/parseGrandLivre');

let enCours = false;
let dernier = null;

async function syncComplet(opts) {
  const options = opts || {};
  if (enCours) return { ok: false, skipped: true, reason: 'un sync est déjà en cours' };
  enCours = true;
  const t0 = Date.now();
  const r = { debut: new Date().toISOString(), etapes: {}, projets: [] };

  try {
    await syncAvantage.preparer();

    // 1. En-têtes : projets + factures client
    const { projets, factures } = await syncAvantage.chargerEntetes();
    r.etapes.projets = await writeProjets(projets);
    r.etapes.factures = await writeFactures(factures);
    console.log('[SYNC] projets', JSON.stringify(r.etapes.projets), 'factures', JSON.stringify(r.etapes.factures));

    // 2. Transactions par projet
    const parProjet = await syncAvantage.chargerTransactionsParProjet();
    const ctx = await chargerContexte();

    const codes = (options.codes && options.codes.length)
      ? options.codes.map(c => normaliserProjet(String(c).replace(/^P/i, '')))
      : [...parProjet.keys()];

    let created = 0, updated = 0, unchanged = 0, errors = 0, total = 0;
    for (const code of codes) {
      const payloads = syncAvantage.transactionsDe(parProjet, code);
      if (!payloads.length) continue;
      const pr = await pousserProjet(code, payloads, ctx);
      r.projets.push(pr);
      created += pr.created || 0; updated += pr.updated || 0; unchanged += pr.unchanged || 0; errors += pr.errors || 0; total += pr.total || 0;
    }
    r.transactions = { projets_avec_transactions: r.projets.length, total, created, updated, unchanged, errors };
    r.source = syncAvantage.provenance();
    r.ok = true;
    console.log('[SYNC] transactions', JSON.stringify(r.transactions));
  } catch (e) {
    r.ok = false; r.error = e.message;
    console.error('[SYNC] échec:', e.message);
  } finally {
    enCours = false;
    r.duree_s = Math.round((Date.now() - t0) / 1000);
    r.fin = new Date().toISOString();
    dernier = {
      ok: r.ok, duree_s: r.duree_s, fin: r.fin,
      projets: r.etapes.projets || null, factures: r.etapes.factures || null,
      transactions: r.transactions || null, error: r.error || null,
    };
  }
  return r;
}

function etat() { return { en_cours: enCours, dernier }; }

module.exports = { syncComplet, etat };
