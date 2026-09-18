// Cycle de synchronisation Avantage → Manoeuvre, à partir de la base .DBF en direct.
//
// Contrainte réelle : Avantage CHIFFRE CONTRA (projets) et FACTMA (factures client).
// On ne peut donc pas lire la liste des projets ni les factures directement.
// Parade : les tables de transactions (PYBBIL, TRANS) portent le numéro de projet EN CLAIR.
// On dérive donc les projets des transactions elles-mêmes, on crée ceux qui manquent dans
// Manoeuvre (sans écraser le nom des projets déjà nommés), puis on y rattache les
// transactions. Les factures client ne sont synchronisées que si FACTMA est lisible.

const syncAvantage = require('../sources/syncAvantage');
const { writeProjets, writeFactures, apiGetAll } = require('../writers/base44-writer');
const { chargerContexte, pousserProjet, trouverProjet } = require('./pousseurTransactions');
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

    // 1. Transactions lues dans la base .DBF (PYBBIL + TRANS), groupées par projet.
    const parProjet = await syncAvantage.chargerTransactionsParProjet();

    // 2. État Manoeuvre.
    const ctx = await chargerContexte();

    const numeros = (options.codes && options.codes.length)
      ? options.codes.map(c => normaliserProjet(String(c).replace(/^P/i, '')))
      : [...parProjet.keys()];

    // 3. Créer les projets manquants (CONTRA chiffré → nom = numéro, à renommer dans Manoeuvre).
    const noms = await syncAvantage.chargerNomsProjets();
    const manquants = numeros.filter(n => n && !trouverProjet(ctx.projets, n));
    if (manquants.length) {
      const nouveaux = manquants.map(n => ({
        numero_projet: 'P' + n,
        nom_projet: (noms[n] && noms[n].nom) || ('Projet ' + n),
        statut: 'actif',
      }));
      r.etapes.projets = await writeProjets(nouveaux);
      ctx.projets = await apiGetAll('Projet'); // recharger pour le rattachement
      console.log('[SYNC] projets manquants créés:', JSON.stringify(r.etapes.projets));
    } else {
      r.etapes.projets = { created: 0, note: 'tous les projets existent déjà' };
    }

    // 4. Factures client — seulement si FACTMA est lisible.
    const fac = await syncAvantage.chargerFacturesLisibles();
    if (fac.chiffree) {
      r.etapes.factures = { skipped: true, raison: 'FACTMA chiffrée par Avantage — factures client non lisibles en direct' };
    } else if (fac.factures.length) {
      r.etapes.factures = await writeFactures(fac.factures);
    } else {
      r.etapes.factures = { created: 0, note: 'aucune facture lisible' };
    }
    console.log('[SYNC] factures', JSON.stringify(r.etapes.factures));

    // 5. Transactions par projet.
    let created = 0, updated = 0, unchanged = 0, errors = 0, total = 0, absents = 0;
    for (const n of numeros) {
      const payloads = syncAvantage.transactionsDe(parProjet, n);
      if (!payloads.length) continue;
      const pr = await pousserProjet(n, payloads, ctx);
      if (pr.ok === false) { absents++; r.projets.push(pr); continue; }
      r.projets.push(pr);
      created += pr.created || 0; updated += pr.updated || 0; unchanged += pr.unchanged || 0;
      errors += pr.errors || 0; total += pr.total || 0;
    }
    r.transactions = { projets: r.projets.length, projets_absents: absents, total, created, updated, unchanged, errors };
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
