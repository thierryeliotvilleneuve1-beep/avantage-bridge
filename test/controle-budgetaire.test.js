const test = require('node:test');
const assert = require('node:assert');
const { generer, DIR } = require('./fixtures/generer');

generer();
process.env.EXPORT_DIR = DIR;
// sources.js lit EXPORT_DIR au chargement : on l'importe apres l'avoir fixe.
const { construireProjet } = require('../src/lib/controle-budgetaire');

const projet = construireProjet('99001');
const parCode = Object.fromEntries(projet.divisions.map((d) => [d.code_division, d]));

test('les divisions sont decouvertes depuis toutes les sources', () => {
  assert.deepStrictEqual(projet.divisions.map((d) => d.code_division).sort(), ['03000', '06101', '16000']);
});

test('les libelles ACTIVE sont resolus', () => {
  assert.strictEqual(parCode['03000'].nom_division, 'BETON');
  assert.strictEqual(parCode['16000'].nom_division, 'ELECTRICITE');
});

test('les autres projets sont exclus', () => {
  assert.ok(!projet.divisions.some((d) => d.montant_initial === 999999));
});

test('CONFIT — seule la derniere DP est retenue', () => {
  assert.strictEqual(parCode['03000'].budget_revenus, 100000); // et non 90000 (DP 1)
});

test('TRANS — les lignes de type R (revenus) sont exclues des couts', () => {
  assert.strictEqual(parCode['03000'].cout_reel, 80000); // et non 300000
});

test('division terminee — marge de 20 %', () => {
  const d = parCode['03000'];
  assert.strictEqual(d.cout_engage, 80000);
  assert.strictEqual(d.prevision_total, 80000);
  assert.strictEqual(d.marge_projetee, 20000);
  assert.strictEqual(d.marge_projetee_pct, 20);
});

test('division en cours — le BC non facture reste dans la prevision', () => {
  const d = parCode['16000'];
  assert.strictEqual(d.cout_reel, 60000);
  assert.strictEqual(d.cout_engage, 120000);      // BC signe a 120k
  assert.strictEqual(d.engagement_restant, 60000);
  assert.strictEqual(d.prevision_total, 120000);  // et non 100k (budget)
  assert.strictEqual(d.marge_projetee, 10000);
  // Depassement du budget de couts detecte : 120k depenses pour 100k budgetes.
  assert.strictEqual(d.recup_pertes, -20000);
});

test('main-d oeuvre — engagee a hauteur du reel malgre l absence de BC', () => {
  const d = parCode['06101'];
  assert.strictEqual(d.mo_total, 45000);
  assert.strictEqual(d.cout_engage, 45000);
  assert.strictEqual(d.prevision_total, 45000);
  assert.strictEqual(d.marge_projetee, 15000);
});

test('rollup projet — marge consolidee et statut', () => {
  const r = projet.rollup;
  assert.strictEqual(r.nb_divisions, 3);
  assert.strictEqual(r.montant_revise, 220000);
  assert.strictEqual(r.budget_revenus, 290000);
  assert.strictEqual(r.prevision_total, 245000);
  assert.strictEqual(r.marge_projetee, 45000);
  assert.strictEqual(r.marge_projetee_pct, 15.52);
  assert.strictEqual(r.statut, 'rouge'); // 11,4 % au-dessus du budget de couts
  assert.strictEqual(r.marge_partielle, false);
});

test('un BC sans division rattachee est signale, pas silencieusement ignore', () => {
  assert.strictEqual(projet.rollup.bc_sans_division, 5000);
  assert.ok(projet.avertissements.some((a) => a.includes('sans division rattachee')));
});

test('toutes les sources sont marquees disponibles et datees', () => {
  Object.entries(projet.sources).forEach(([nom, s]) => {
    assert.strictEqual(s.disponible, true, nom + ' devrait etre disponible');
    assert.ok(s.maj, nom + ' devrait porter une date de fraicheur');
  });
});

test('sans avertissement bloquant quand toutes les sources sont la', () => {
  const bloquants = projet.avertissements.filter((a) => a.includes('absent'));
  assert.deepStrictEqual(bloquants, []);
});

test('les ODC relevent le budget revise et effacent le faux depassement', () => {
  const avecOdc = construireProjet('99001', { odcParDivision: { '16000': 25000 } });
  const d = avecOdc.divisions.find((x) => x.code_division === '16000');
  assert.strictEqual(d.odc, 25000);
  assert.strictEqual(d.montant_revise, 125000);
  // Sans ODC la division lisait -20 000 $ de depassement. Avec l'ODC au budget,
  // le depassement disparait : c'est precisement le correctif recherche.
  assert.strictEqual(d.recup_pertes, 0);
  assert.strictEqual(avecOdc.rollup.statut, 'vert');
});

test('methode engagement — le budget residuel non engage n est pas suppose depense', () => {
  const avecOdc = construireProjet('99001', {
    odcParDivision: { '16000': 25000 }, methode: 'engagement',
  });
  const d = avecOdc.divisions.find((x) => x.code_division === '16000');
  // 125k de budget revise mais seulement 120k engages : en cloture, on ne
  // depensera pas les 5k residuels, donc ils reviennent en marge.
  assert.strictEqual(d.prevision_total, 120000);
  assert.strictEqual(d.recup_pertes, 5000);
  assert.strictEqual(d.marge_projetee, 10000);
});

test('methode engagement — ne compte pas le budget residuel non engage', () => {
  const parBudget = construireProjet('99001', { methode: 'budget' });
  const parEngagement = construireProjet('99001', { methode: 'engagement' });
  assert.strictEqual(parBudget.rollup.prevision_total, 245000);
  assert.strictEqual(parEngagement.rollup.prevision_total, 245000);
  // Les deux coincident ici car tout est engage — c'est la garantie de coherence.
  parBudget.divisions.forEach((d) => assert.strictEqual(d.prevision_methode, 'budget'));
  parEngagement.divisions.forEach((d) => assert.strictEqual(d.prevision_methode, 'engagement'));
});

test('projet inexistant — resultat vide, pas une exception', () => {
  const vide = construireProjet('70000');
  assert.strictEqual(vide.divisions.length, 0);
  assert.strictEqual(vide.rollup.marge_projetee, null);
  assert.strictEqual(vide.rollup.statut, 'inconnu');
});
