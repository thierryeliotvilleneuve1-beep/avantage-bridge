// Cycle de synchronisation Avantage → Manoeuvre, à partir de la base .DBF en direct.
//
// Contrainte réelle : Avantage CHIFFRE CONTRA (projets) et FACTMA (factures client).
// On ne peut donc pas lire la liste des projets ni les factures directement.
// Parade : les tables de transactions (PYBBIL, TRANS) portent le numéro de projet EN CLAIR.
// On dérive donc les projets des transactions elles-mêmes, on crée ceux qui manquent dans
// Manoeuvre (sans écraser le nom des projets déjà nommés), puis on y rattache les
// transactions. Les factures client ne sont synchronisées que si FACTMA est lisible.

const syncAvantage = require('../sources/syncAvantage');
const { writeFactures, apiGetAll } = require('../writers/base44-writer');
const { chargerContexte, pousserProjet, trouverProjet } = require('./pousseurTransactions');
const { pousserBonsProjet } = require('./pousseurBonsCommande');
const pousseurPaiements = require('./pousseurPaiements');
const { syncBudgetControle } = require('./syncBudgetControle');
const alertesBudget = require('./alertesBudget');
const snapshotBudget = require('./snapshotBudget');
const pousseurDemandesPaiement = require('./pousseurDemandesPaiement');
const moniteur = require('./moniteurFichiers');
const notificateur = require('./notificateur');
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

    // 0. Gating incrémental (mtime des .DBF). Un sync manuel de projets ciblés, ou options.force,
    // force le cycle complet. Sinon, chaque source n'est retraitée que si son fichier a bougé.
    const force = options.force === true || !!(options.codes && options.codes.length);
    const etat = moniteur.charger();
    const chg = {
      trans:  force || moniteur.aChange(etat, ['TRANS', 'PYBBIL']),
      budget: force || moniteur.aChange(etat, ['CONPRE', 'CONACT', 'TRANS']),
      bc:     force || moniteur.aChange(etat, ['COMITE', 'TRANS', 'PYBBIL']),
      fact:   force || moniteur.aChange(etat, ['FACTMA']),
      paie:   force || moniteur.aChange(etat, ['PYBACM', 'TRANS', 'PYBBIL']),
      dp:     force || moniteur.aChange(etat, ['CONFIT']),
    };
    r.gating = { actif: moniteur.actif(), force, changements: chg };

    // Cycle tranquille : rien n'a bougé côté Avantage → on ne relit ni ne réécrit rien.
    if (moniteur.actif() && !force && !Object.values(chg).some(Boolean)) {
      r.ok = true; r.tranquille = true;
      r.etapes.cycle = 'tranquille — aucun fichier .DBF Avantage modifié depuis le dernier sync';
      console.log('[SYNC] cycle tranquille — aucun changement Avantage, rien à faire');
      return r;
    }

    // 1. Transactions lues dans la base .DBF (PYBBIL + TRANS), groupées par projet — seulement
    // si les transactions ou les BC (qui en dépendent) doivent être retraités.
    const parProjet = (chg.trans || chg.bc) ? await syncAvantage.chargerTransactionsParProjet() : new Map();

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

    // 4. Factures client. Voie OFFICIELLE : la passerelle SDK déchiffre FACTMA (n° de facture,
    // date, taxes, retenue). On l'utilise si elle est active ; sinon on retombe sur la lecture
    // directe (qui échoue tant que FACTMA est chiffrée). Gardé : une passerelle tombée ne casse
    // pas le cycle (l'étape est simplement notée en échec doux).
    const factSDK = require('./syncFacturesSDK');
    const lectFact = require('./lectureFactures');
    if (!chg.fact) {
      r.etapes.factures = { skipped: true, raison: 'FACTMA inchangée (mtime)' };
    } else if (lectFact.actif()) {
      try {
        r.etapes.factures = await factSDK.syncFacturesSDK({ projets: ctx.projets }, { dryRun: false });
      } catch (e) {
        r.etapes.factures = { ok: false, voie: 'SDK', erreur: e.message };
        console.error('[SYNC] factures SDK', e.message);
      }
    } else {
      const fac = await syncAvantage.chargerFacturesLisibles();
      if (fac.chiffree) r.etapes.factures = { skipped: true, raison: 'FACTMA chiffrée — activer la passerelle SDK (AVANTAGE_SDK_ACTIF)' };
      else if (fac.factures.length) r.etapes.factures = await writeFactures(fac.factures);
      else r.etapes.factures = { created: 0, note: 'aucune facture lisible' };
    }
    console.log('[SYNC] factures', JSON.stringify(r.etapes.factures));

    // 5. Contrôle budgétaire par division (budget, revenus, facturé, engagé, MO) — AVANT
    // les transactions, pour que les divisions existent et que les transactions s'y
    // rattachent dès le premier passage. Validé au cent près contre l'écran Avantage.
    let actMap = {};
    const cb = { projets: 0, created: 0, updated: 0, unchanged: 0, errors: 0 };
    if (chg.budget) {
      try { actMap = require('../sources/depotDbf').lireActivites(); } catch (e) {}
      for (const n of aTraiter) {
        try {
          const rb = await syncBudgetControle(n, ctx, actMap);
          if (rb.ok) { cb.projets++; cb.created += rb.created || 0; cb.updated += rb.updated || 0; cb.unchanged += rb.unchanged || 0; cb.errors += rb.errors || 0; }
        } catch (e) { cb.errors++; console.error('[SYNC] budget', n, e.message); }
      }
    } else { cb.skipped = 'budget inchangé (mtime)'; }
    r.controle_budgetaire = cb;
    console.log('[SYNC] contrôle budgétaire', JSON.stringify(cb));

    // Recharger les divisions : le rattachement des BC et des transactions en dépend.
    if (cb.created || cb.updated) ctx.divisions = await apiGetAll('ControleBudgetaire');

    // 6. Bons de commande reconstruits (PYBBIL + COMITE) — AVANT les transactions, pour que
    // chaque transaction puisse se rattacher à son BC. COMMAN (montant engagé réel) est
    // chiffrée : le Total PO est approximé par le facturé (voir pousseurBonsCommande).
    const bc = { projets: 0, created: 0, updated: 0, unchanged: 0, errors: 0 };
    if (chg.bc) {
      for (const n of aTraiter) {
        const payloads = syncAvantage.transactionsDe(parProjet, n);
        if (!payloads.length) continue;
        try {
          const rbc = await pousserBonsProjet(n, payloads, ctx);
          if (rbc.ok) { bc.projets++; bc.created += rbc.created || 0; bc.updated += rbc.updated || 0; bc.unchanged += rbc.unchanged || 0; bc.errors += rbc.errors || 0; }
        } catch (e) { bc.errors++; console.error('[SYNC] bons de commande', n, e.message); }
      }
    } else { bc.skipped = 'BC inchangés (mtime)'; }
    r.bons_de_commande = bc;
    console.log('[SYNC] bons de commande', JSON.stringify(bc));

    // Recharger les BC : le rattachement bon_de_commande_id des transactions en dépend.
    if (bc.created || bc.updated) ctx.bcs = await apiGetAll('BonDeCommande');

    // 7. Transactions par projet (rattachées aux divisions et aux BC qui existent maintenant).
    let created = 0, updated = 0, unchanged = 0, errors = 0, total = 0;
    if (chg.trans) {
      for (const n of aTraiter) {
        const payloads = syncAvantage.transactionsDe(parProjet, n);
        if (!payloads.length) continue;
        const pr = await pousserProjet(n, payloads, ctx);
        r.projets.push(pr);
        created += pr.created || 0; updated += pr.updated || 0; unchanged += pr.unchanged || 0;
        errors += pr.errors || 0; total += pr.total || 0;
      }
      r.transactions = { projets: r.projets.length, projets_absents: absents.length, total, created, updated, unchanged, errors };
    } else {
      r.transactions = { skipped: 'transactions inchangées (mtime)' };
    }
    console.log('[SYNC] transactions', JSON.stringify(r.transactions));

    // 8. Paiements fournisseurs (PYBACM) rattachés à chaque transaction. On recharge les
    // transactions (pour leur _id Manoeuvre) et les paiements existants, puis on pousse.
    const pf = { projets: 0, created: 0, updated: 0, unchanged: 0, errors: 0 };
    if (chg.paie) {
      try {
        pousseurPaiements.reset();
        if (pousseurPaiements.chargerPaiements().size) {
          ctx.transactions = await apiGetAll('TransactionAvantage');
          ctx.paiements = await apiGetAll('PaiementFournisseur');
          for (const n of aTraiter) {
            const rp = await pousseurPaiements.pousserPaiementsProjet(n, ctx);
            if (rp.ok) { pf.projets++; pf.created += rp.created || 0; pf.updated += rp.updated || 0; pf.unchanged += rp.unchanged || 0; pf.errors += rp.errors || 0; }
          }
        }
      } catch (e) { pf.errors++; console.error('[SYNC] paiements', e.message); }
    } else { pf.skipped = 'paiements inchangés (mtime)'; }
    r.paiements = pf;
    console.log('[SYNC] paiements', JSON.stringify(pf));

    // 9. Alertes budgétaires par exception (dépassements / seuils) sur l'état à jour.
    try { r.alertes_budget = await alertesBudget.verifier(ctx.divisions, ctx.projets); }
    catch (e) { console.error('[SYNC] alertes budget', e.message); }

    // 11. Demandes de paiement (CONFIT) — état courant par projet actif, recopié tel quel.
    if (process.env.DP_ACTIF !== 'false') {
      if (!chg.dp) { r.demandes_paiement = { skipped: 'CONFIT inchangée (mtime)' }; }
      else {
        try { r.demandes_paiement = await pousseurDemandesPaiement.pousserToutesDemandes(ctx); console.log('[SYNC] demandes paiement', JSON.stringify(r.demandes_paiement)); }
        catch (e) { console.error('[SYNC] demandes paiement', e.message); }
      }
    }

    // 10. Photo hebdomadaire du budget (WIP, récupération, tendance). Idempotent : une seule
    // photo par projet par semaine ISO, donc s'écrit au premier sync de la semaine puis se met
    // à jour sans se dupliquer. SNAPSHOT_ACTIF=false pour désactiver.
    if (process.env.SNAPSHOT_ACTIF !== 'false') {
      try { r.snapshot = await snapshotBudget.prendreSnapshot(ctx); console.log('[SYNC] snapshot', JSON.stringify(r.snapshot)); }
      catch (e) { console.error('[SYNC] snapshot', e.message); }
    }

    r.source = syncAvantage.provenance();
    r.ok = true;

    // Notifier si des erreurs sont survenues malgré un cycle « ok ».
    const errFact = (r.etapes.factures && (r.etapes.factures.errors || r.etapes.factures.erreurs)) || 0;
    const totalErreurs = (cb.errors || 0) + (bc.errors || 0) + (pf.errors || 0) + (errors || 0) + errFact;

    // Gating : on n'avance les repères mtime QUE si le cycle est propre (aucune erreur). Une
    // étape en échec laisse son fichier « non vu » → elle sera retentée au prochain cycle.
    if (moniteur.actif() && totalErreurs === 0) {
      moniteur.marquer(etat, ['TRANS', 'PYBBIL', 'CONPRE', 'CONACT', 'COMITE', 'FACTMA', 'PYBACM', 'CONFIT']);
      r.gating.repere_sauve = moniteur.sauver(etat);
    }

    if (totalErreurs > 0 && notificateur.disponible()) {
      await notificateur.envoyer('Sync Avantage terminé avec des erreurs',
        totalErreurs + ' erreur(s) durant le cycle (budget ' + (cb.errors || 0) + ', BC ' + (bc.errors || 0) +
        ', transactions ' + (errors || 0) + ', paiements ' + (pf.errors || 0) + '). Vérifier les journaux PM2.',
        { emoji: '⚠️' });
    }
  } catch (e) {
    r.ok = false; r.error = e.message;
    console.error('[SYNC] échec:', e.message);
    try { if (notificateur.disponible()) await notificateur.envoyer('Sync Avantage EN ÉCHEC', 'Le cycle a échoué : ' + e.message + '. Le contrôle budgétaire de Manoeuvre n\'est plus à jour tant que ce n\'est pas corrigé.', { emoji: '🔴' }); } catch (e2) {}
  } finally {
    enCours = false;
    r.duree_s = Math.round((Date.now() - t0) / 1000);
    r.fin = new Date().toISOString();
    dernier = {
      ok: r.ok, duree_s: r.duree_s, fin: r.fin,
      projets: r.etapes.projets || null, factures: r.etapes.factures || null,
      transactions: r.transactions || null, controle_budgetaire: r.controle_budgetaire || null,
      bons_de_commande: r.bons_de_commande || null, paiements: r.paiements || null, error: r.error || null,
    };
  }
  return r;
}

function etat() { return { en_cours: enCours, dernier }; }

module.exports = { syncComplet, etat };
