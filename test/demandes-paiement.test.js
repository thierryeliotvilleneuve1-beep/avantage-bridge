// Pousseur des demandes de paiement (CONFIT → DemandesPaiement + LignesDP).
// Lancer : node test/demandes-paiement.test.js
//
// On simule CONFIT et Base44 (aucun accès disque ni réseau) pour valider :
//   • seuls les projets actifs présents sont traités ;
//   • un en-tête « courant » numero_dp = 0, statut Brouillon ;
//   • les lignes recopient les montants d'Avantage et se lient à la division budgétaire ;
//   • le différentiel (2e passage sans changement = 0 réécriture).

const dpDbf = require('../src/sources/demandesPaiementDbf');
const writer = require('../src/writers/base44-writer');

let echecs = 0;
function check(nom, reel, attendu) {
  const ok = JSON.stringify(reel) === JSON.stringify(attendu);
  if (!ok) { echecs++; console.log('  ÉCHEC ' + nom + ' — attendu ' + JSON.stringify(attendu) + ', obtenu ' + JSON.stringify(reel)); }
  else console.log('  ok    ' + nom + ' = ' + JSON.stringify(reel));
}

// ── Stub du lecteur CONFIT ───────────────────────────────────────────────────
dpDbf.disponible = () => true;
dpDbf.lireParProjet = () => new Map([
  [26004, { contrat: 26004, montant_total: 682275.79, montant_cumulatif: 1783130.86, prix_contractuel: 6604877.33, divisions: [
    { code_division: '00400', prix_contractuel: 661438, montant_anterieur: 198431.4, montant_cumulatif: 291032.72, montant_dp: 92601.32, pourcentage_dp: 0, pourcentage_cumulatif: 44 },
    { code_division: '02070', prix_contractuel: 566940, montant_anterieur: 214303.32, montant_cumulatif: 309549.24, montant_dp: 95245.92, pourcentage_dp: 0, pourcentage_cumulatif: 54.6 },
  ] }],
  [99999, { contrat: 99999, divisions: [ { code_division: '01000', prix_contractuel: 100, montant_anterieur: 0, montant_cumulatif: 0, montant_dp: 0, pourcentage_dp: 0, pourcentage_cumulatif: 0 } ] }], // projet non présent dans Manoeuvre
]);

// ── Stub de Base44 (capture des écritures) ───────────────────────────────────
let store = { DemandesPaiement: [], LignesDP: [] };
let seq = 0;
writer.apiGetAll = async (e) => (store[e] || []).map(x => ({ ...x }));
writer.sleep = async () => {};
writer.upsert = async (entity, id, payload) => {
  if (id) {
    const arr = store[entity]; const i = arr.findIndex(x => (x._id || x.id) === id);
    if (i >= 0) arr[i] = { ...arr[i], ...payload };
    return { ok: true, body: arr[i] };
  }
  const rec = { _id: entity + '-' + (++seq), ...payload };
  store[entity].push(rec);
  return { ok: true, body: rec };
};

const pousseur = require('../src/services/pousseurDemandesPaiement');

const ctx = {
  projets: [
    { _id: 'p1', code_projet: 'P26004', statut: 'actif' },
    { _id: 'p2', code_projet: 'P25010', statut: 'termine' }, // inactif → ignoré
  ],
  divisions: [
    { _id: 'cb1', projet_id: 'p1', code_division: '00400', nom_division: 'Conditions générales' },
    { _id: 'cb2', projet_id: 'p1', code_division: '02070', nom_division: 'Excavation' },
  ],
};

(async () => {
  console.log('--- 1er passage (création) ---');
  const r1 = await pousseur.pousserToutesDemandes(ctx);
  check('1 projet traité', r1.projets, 1);
  check('1 en-tête maj', r1.entetes_maj, 1);
  check('2 lignes créées', r1.lignes_created, 2);
  check('0 erreur', r1.errors, 0);

  const dp = store.DemandesPaiement[0];
  check('en-tête lié au projet actif', dp.projet_id, 'p1');
  check('numero_dp sentinelle = 0', dp.numero_dp, 0);
  check('statut Brouillon', dp.statut, 'Brouillon');
  check('montant_total = somme des DP', dp.montant_total, 682275.79);
  check('un seul en-tête (projet inactif + absent ignorés)', store.DemandesPaiement.length, 1);

  const l = store.LignesDP.find(x => x.code_division === '00400');
  check('ligne liée à la division budgétaire', l.controle_budgetaire_id, 'cb1');
  check('nom division repris du budget', l.nom_division, 'Conditions générales');
  check('montant cumulatif recopié', l.montant_cumulatif, 291032.72);
  check('montant DP recopié', l.montant_dp, 92601.32);
  check('% cumulatif recopié', l.pourcentage_cumulatif, 44);
  check('pas de pourcentage_dp écrit (champ CP)', l.pourcentage_dp, undefined);

  console.log('\n--- 2e passage (différentiel : rien ne change) ---');
  const r2 = await pousseur.pousserToutesDemandes(ctx);
  check('0 en-tête réécrit', r2.entetes_maj, 0);
  check('0 ligne créée', r2.lignes_created, 0);
  check('0 ligne mise à jour', r2.lignes_updated, 0);
  check('2 lignes inchangées', r2.lignes_unchanged, 2);

  console.log('\n--- 3e passage (un montant change) ---');
  dpDbf.lireParProjet = () => new Map([[26004, { contrat: 26004, montant_total: 700000, divisions: [
    { code_division: '00400', prix_contractuel: 661438, montant_anterieur: 198431.4, montant_cumulatif: 300000, montant_dp: 101568.6, pourcentage_dp: 0, pourcentage_cumulatif: 45.4 },
    { code_division: '02070', prix_contractuel: 566940, montant_anterieur: 214303.32, montant_cumulatif: 309549.24, montant_dp: 95245.92, pourcentage_dp: 0, pourcentage_cumulatif: 54.6 },
  ] }]]);
  const r3 = await pousseur.pousserToutesDemandes(ctx);
  check('en-tête réécrit (montant_total changé)', r3.entetes_maj, 1);
  check('1 ligne mise à jour', r3.lignes_updated, 1);
  check('1 ligne inchangée', r3.lignes_unchanged, 1);

  console.log(echecs ? '\n' + echecs + ' ÉCHEC(S)' : '\nTous les tests passent');
  process.exit(echecs ? 1 : 0);
})();
