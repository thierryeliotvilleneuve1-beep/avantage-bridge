// Cycle de synchronisation Avantage → Manoeuvre, à partir de la base .DBF en direct.
//
// Contrainte réelle : Avantage CHIFFRE CONTRA (projets) et FACTMA (factures client).
// On ne peut donc pas lire la liste des projets ni les factures directement.
// Parade : les tables de transactions (PYBBIL, TRANS) portent le numéro de projet EN CLAIR.
// On dérive donc les projets des transactions elles-mêmes, on crée ceux qui manquent dans
// Manoeuvre (sans écraser le nom des projets déjà nommés), puis on y rattache les
// transactions. Les factures client ne sont synchronisées que si FACTMA est lisible.

const syncAvantage = require('../sources/syncAvantage');
const { writeFactures } = require('../writers/base44-writer');
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

    // 3. On ne CRÉE PAS de projets. L'historique des transactions contient des centaines
    // de projets clos ; les créer inonderait Manoeuvre de fiches vides. La liste des projets
    // vient de Manoeuvre (créés par l'équipe, ou importés de CONTRA en clair via un CSV).
    // On synchronise donc les transactions des seuls projets déjà présents dans Manoeuvre.
    const presents = new Set(ctx.projets.map(p => (p.code_projet || '').replace(/^P/i, '')));
    const aTraiter = numeros.filter(n => n && trouverProjet(ctx.projets, n));
    const absents = numeros.filter(n => n && !trouverProjet(ctx.projets, n));
    r.etapes.projets = {
      created: 0,
      dans_manoeuvre: aTraiter.length,
      absents: absents.length,
      note: absents.length
        ? absents.length + ' projet(s) de l\'historique absents de Manoeuvre — transactions ignorées (créer le projet dans Manoeuvre pour les importer)'
        : 'tous les projets à synchroniser existent dans Manoeuvre',
    };
    r.projets_absents_codes = absents.slice(0, 30);
    console.log('[SYNC] projets:', aTraiter.length, 'dans Manoeuvre,', absents.length, 'absents (ignorés)');

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
    let created = 0, updated = 0, unchanged = 0, errors = 0, total = 0;
    for (const n of aTraiter) {
      const payloads = syncAvantage.transactionsDe(parProjet, n);
      if (!payloads.length) continue;
      const pr = await pousserProjet(n, payloads, ctx);
      r.projets.push(pr);
      created += pr.created || 0; updated += pr.updated || 0; unchanged += pr.unchanged || 0;
      errors += pr.errors || 0; total += pr.total || 0;
    }
    r.transactions = { projets: r.projets.length, projets_absents: absents.length, total, created, updated, unchanged, errors };
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
