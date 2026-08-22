/**
 * Calculs de marge et de prevision a terminaison (EAC) — bridge Avantage -> Manoeuvre.
 *
 * Ce module est volontairement pur : aucune lecture de fichier, aucun appel reseau.
 * Toute la logique financiere est ici pour qu'elle soit testable sans Avantage.
 *
 * Regle de gouvernance CRC appliquee ici : on ne presente jamais un chiffre estime
 * comme un chiffre etabli. Chaque resultat porte la methode qui l'a produit
 * (champ `prevision_methode`) et un indicateur de fraicheur des sources.
 */

function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Cout engage d'une division, selon la definition portee par le schema
 * ControleBudgetaire de Manoeuvre :
 *   sum(BCs, max(montant_prevu, montant_facture)) + transactions sans BC
 *
 * Un BC facture au-dela de sa valeur compte pour ce qui est reellement facture :
 * un depassement est un engagement, pas une economie.
 *
 * @param {Array<{montant_prevu:number, montant_facture:number}>} bcs
 * @param {number} transactionsSansBC  depenses reelles non rattachees a un BC
 */
function computeCoutEngage(bcs, transactionsSansBC) {
  const surBC = (bcs || []).reduce((acc, bc) => {
    const prevu = Number(bc.montant_prevu) || 0;
    const facture = Number(bc.montant_facture) || 0;
    return acc + Math.max(prevu, facture);
  }, 0);
  return r2(surBC + (Number(transactionsSansBC) || 0));
}

/**
 * Prevision a terminaison (EAC) d'une division.
 *
 * Deux methodes sont calculees, jamais une seule :
 *
 *  - `budget`      : on suppose que le budget non encore engage sera depense.
 *                    Conservateur. C'est le defaut en cours de chantier.
 *  - `engagement`  : on ne compte que ce qui est reellement engage ou annonce.
 *                    Realiste en fin de chantier, quand le budget residuel
 *                    ne sera jamais depense.
 *
 * Le choix par defaut est `budget` : mieux vaut annoncer une marge trop faible
 * et la voir remonter, que l'inverse.
 *
 * @param {object} p
 * @param {number} p.coutReel        depenses reelles a ce jour (AC)
 * @param {number} p.coutEngage      engagement total (voir computeCoutEngage)
 * @param {number} p.depenseAVenir   depense annoncee non encore engagee (CONACT)
 * @param {number} p.budgetRevise    budget de couts revise (initial + ODC)
 * @param {'budget'|'engagement'} [p.methode]
 */
function computeEAC({ coutReel, coutEngage, depenseAVenir, budgetRevise, methode = 'budget' }) {
  const ac = Number(coutReel) || 0;
  const engage = Number(coutEngage) || 0;
  const dav = Number(depenseAVenir) || 0;
  const budget = Number(budgetRevise) || 0;

  // Portion des BC signes qui n'est pas encore passee en depense reelle.
  const engagementRestant = Math.max(0, engage - ac);
  // Portion du budget qui n'est ni depensee, ni engagee, ni annoncee.
  const budgetNonEngage = Math.max(0, budget - Math.max(ac, engage) - dav);

  const etcEngagement = engagementRestant + dav;
  const etcBudget = etcEngagement + budgetNonEngage;
  const etc = methode === 'engagement' ? etcEngagement : etcBudget;

  return {
    cout_reel: r2(ac),
    cout_engage: r2(engage),
    engagement_restant: r2(engagementRestant),
    budget_non_engage: r2(budgetNonEngage),
    etc: r2(etc),
    prevision_total: r2(ac + etc),
    prevision_engagement_seul: r2(ac + etcEngagement),
    prevision_methode: methode,
  };
}

/**
 * Marge d'une division ou d'un projet.
 *
 * Retourne `null` pour les pourcentages quand le revenu est inconnu (0) plutot
 * que 0 % : une marge inconnue n'est pas une marge nulle, et l'afficher comme
 * telle donnerait une fausse alerte rouge sur tout projet sans CONFIT.
 */
function computeMarge({ budgetRevenus, previsionTotal }) {
  const revenu = Number(budgetRevenus) || 0;
  const cout = Number(previsionTotal) || 0;
  const marge = revenu - cout;
  return {
    budget_revenus: r2(revenu),
    prevision_total: r2(cout),
    marge_projetee: revenu > 0 ? r2(marge) : null,
    marge_projetee_pct: revenu > 0 ? r2((marge / revenu) * 100) : null,
    revenu_connu: revenu > 0,
  };
}

/**
 * Seuils de suivi budgetaire CRC (04-Connaissances / skill gestion financiere).
 * Ecart defavorable en % du budget revise.
 */
function statutEcart(ecartPct) {
  if (ecartPct === null || ecartPct === undefined) return 'inconnu';
  if (ecartPct <= 3) return 'vert';
  if (ecartPct <= 8) return 'jaune';
  return 'rouge';
}

/**
 * Consolide les divisions d'un projet en une vue de marge unique.
 *
 * @param {Array<object>} divisions  lignes deja calculees (voir computeDivision)
 */
function agregerProjet(divisions) {
  const somme = (champ) => r2((divisions || []).reduce((a, d) => a + (Number(d[champ]) || 0), 0));

  const budgetRevenus = somme('budget_revenus');
  const previsionTotal = somme('prevision_total');
  const budgetRevise = somme('montant_revise');
  const coutReel = somme('cout_reel');

  const marge = computeMarge({ budgetRevenus, previsionTotal });
  const ecartPct = budgetRevise > 0 ? r2(((previsionTotal - budgetRevise) / budgetRevise) * 100) : null;

  // Une seule division sans revenu connu suffit a rendre la marge du projet partielle.
  const divisionsSansRevenu = (divisions || []).filter((d) => !(Number(d.budget_revenus) > 0)).length;

  return {
    nb_divisions: (divisions || []).length,
    montant_initial: somme('montant_initial'),
    montant_revise: budgetRevise,
    budget_revenus: budgetRevenus,
    cout_reel: coutReel,
    cout_engage: somme('cout_engage'),
    facture: somme('facture'),
    prevision_total: previsionTotal,
    marge_projetee: marge.marge_projetee,
    marge_projetee_pct: marge.marge_projetee_pct,
    ecart_budget_pct: ecartPct,
    statut: statutEcart(ecartPct),
    divisions_sans_revenu: divisionsSansRevenu,
    marge_partielle: divisionsSansRevenu > 0,
  };
}

/**
 * Calcule une ligne de division complete a partir des donnees brutes Avantage.
 * C'est le point d'entree utilise par les routes.
 */
function computeDivision({
  code_division,
  nom_division,
  montant_initial = 0,
  odc = 0,
  budget_revenus = 0,
  // Couts reels HORS main-d'oeuvre. La MO arrive separement par `mo_total`
  // parce qu'elle ne transite pas par des bons de commande. La sortie
  // `cout_reel` de cette fonction est le TOTAL des deux.
  cout_reel_hors_mo = 0,
  mo_total = 0,
  bcs = [],
  transactions_sans_bc = 0,
  depense_a_venir = 0,
  facture = 0,
  methode = 'budget',
}) {
  const montantRevise = r2((Number(montant_initial) || 0) + (Number(odc) || 0));
  const coutReelTotal = r2((Number(cout_reel_hors_mo) || 0) + (Number(mo_total) || 0));
  const coutEngage = computeCoutEngage(bcs, transactions_sans_bc);

  const eac = computeEAC({
    coutReel: coutReelTotal,
    // La MO ne passe pas par des BC : elle est toujours au moins engagee a hauteur du reel.
    coutEngage: Math.max(coutEngage, coutReelTotal),
    depenseAVenir: depense_a_venir,
    budgetRevise: montantRevise,
    methode,
  });

  const marge = computeMarge({ budgetRevenus: budget_revenus, previsionTotal: eac.prevision_total });

  return {
    code_division,
    nom_division,
    montant_initial: r2(montant_initial),
    odc: r2(odc),
    montant_revise: montantRevise,
    budget_revenus: r2(budget_revenus),
    cout_reel: eac.cout_reel,
    mo_total: r2(mo_total),
    cout_engage: eac.cout_engage,
    engagement_restant: eac.engagement_restant,
    depense_a_venir: r2(depense_a_venir),
    prevision_total: eac.prevision_total,
    prevision_engagement_seul: eac.prevision_engagement_seul,
    prevision_methode: eac.prevision_methode,
    facture: r2(facture),
    // Ecart contre le budget REVISE, pas le budget initial : c'est le correctif
    // de fond. Compare a l'initial, l'ecart devient faux des le premier ODC.
    recup_pertes: r2(montantRevise - eac.prevision_total),
    pourcentage: montantRevise > 0 ? r2((eac.prevision_total / montantRevise) * 100) : 0,
    marge_projetee: marge.marge_projetee,
    marge_projetee_pct: marge.marge_projetee_pct,
  };
}

module.exports = {
  r2,
  computeCoutEngage,
  computeEAC,
  computeMarge,
  computeDivision,
  agregerProjet,
  statutEcart,
};
