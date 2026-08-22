const test = require('node:test');
const assert = require('node:assert');
const {
  computeCoutEngage, computeEAC, computeMarge, computeDivision, agregerProjet, statutEcart,
} = require('../src/lib/marge');

test('cout engage — un BC facture sous sa valeur reste engage a sa valeur', () => {
  const r = computeCoutEngage([{ montant_prevu: 100000, montant_facture: 40000 }], 0);
  assert.strictEqual(r, 100000);
});

test('cout engage — un BC facture au-dela de sa valeur compte le depassement', () => {
  const r = computeCoutEngage([{ montant_prevu: 100000, montant_facture: 118000 }], 0);
  assert.strictEqual(r, 118000);
});

test('cout engage — les depenses sans BC s ajoutent', () => {
  const r = computeCoutEngage([{ montant_prevu: 50000, montant_facture: 0 }], 12500.55);
  assert.strictEqual(r, 62500.55);
});

test('EAC — projet non demarre : la prevision egale le budget', () => {
  const r = computeEAC({ coutReel: 0, coutEngage: 0, depenseAVenir: 0, budgetRevise: 100000 });
  assert.strictEqual(r.prevision_total, 100000);
  assert.strictEqual(r.etc, 100000);
});

test('EAC — tout engage, a moitie facture : la prevision tient le budget', () => {
  const r = computeEAC({ coutReel: 50000, coutEngage: 100000, depenseAVenir: 0, budgetRevise: 100000 });
  assert.strictEqual(r.prevision_total, 100000);
  assert.strictEqual(r.engagement_restant, 50000);
  assert.strictEqual(r.budget_non_engage, 0);
});

test('EAC — depassement : la prevision depasse le budget', () => {
  const r = computeEAC({ coutReel: 120000, coutEngage: 120000, depenseAVenir: 0, budgetRevise: 100000 });
  assert.strictEqual(r.prevision_total, 120000);
  assert.strictEqual(r.budget_non_engage, 0);
});

test('EAC — fin de chantier sous budget : les deux methodes divergent, et c est voulu', () => {
  const p = { coutReel: 90000, coutEngage: 90000, depenseAVenir: 0, budgetRevise: 100000 };
  const budget = computeEAC({ ...p, methode: 'budget' });
  const engagement = computeEAC({ ...p, methode: 'engagement' });
  assert.strictEqual(budget.prevision_total, 100000);      // conservateur
  assert.strictEqual(engagement.prevision_total, 90000);   // realiste en cloture
  assert.strictEqual(budget.prevision_engagement_seul, 90000);
});

test('EAC — la depense a venir est comptee une seule fois', () => {
  const r = computeEAC({ coutReel: 20000, coutEngage: 60000, depenseAVenir: 15000, budgetRevise: 100000 });
  // restant sur BC 40000 + a venir 15000 + non engage (100000-60000-15000)=25000 => ETC 80000
  assert.strictEqual(r.etc, 80000);
  assert.strictEqual(r.prevision_total, 100000);
});

test('marge — revenu inconnu ne devient jamais une marge de 0 %', () => {
  const r = computeMarge({ budgetRevenus: 0, previsionTotal: 80000 });
  assert.strictEqual(r.marge_projetee, null);
  assert.strictEqual(r.marge_projetee_pct, null);
  assert.strictEqual(r.revenu_connu, false);
});

test('marge — calcul nominal a 20 %', () => {
  const r = computeMarge({ budgetRevenus: 100000, previsionTotal: 80000 });
  assert.strictEqual(r.marge_projetee, 20000);
  assert.strictEqual(r.marge_projetee_pct, 20);
});

test('marge — marge negative correctement signee', () => {
  const r = computeMarge({ budgetRevenus: 100000, previsionTotal: 112000 });
  assert.strictEqual(r.marge_projetee, -12000);
  assert.strictEqual(r.marge_projetee_pct, -12);
});

test('division — l ecart se mesure contre le budget REVISE, pas l initial', () => {
  // C'est le bug de fond corrige : 100k de budget + 30k d'ODC, 125k de couts.
  // Contre l'initial on lirait un depassement de 25 %. Contre le revise, une economie.
  const d = computeDivision({
    code_division: '16000', nom_division: 'ELECTRICITE',
    montant_initial: 100000, odc: 30000,
    cout_reel_hors_mo: 125000, bcs: [{ montant_prevu: 125000, montant_facture: 125000 }],
  });
  assert.strictEqual(d.montant_revise, 130000);
  assert.strictEqual(d.prevision_total, 130000); // budget non engage encore suppose depense
  assert.strictEqual(d.recup_pertes, 0);
  assert.ok(d.pourcentage <= 100, 'pas de faux depassement');
});

test('division — la MO sans BC est toujours au moins engagee a hauteur du reel', () => {
  const d = computeDivision({
    code_division: '06101', nom_division: 'MAIN D OEUVRE',
    montant_initial: 50000, mo_total: 62000, bcs: [],
  });
  assert.strictEqual(d.cout_reel, 62000);
  assert.strictEqual(d.cout_engage, 62000);
  assert.strictEqual(d.prevision_total, 62000);
  assert.strictEqual(d.recup_pertes, -12000); // depassement reel, correctement signe
});

test('division — marge par division quand le revenu est connu', () => {
  const d = computeDivision({
    code_division: '03000', nom_division: 'BETON',
    montant_initial: 80000, budget_revenus: 100000,
    cout_reel_hors_mo: 80000, bcs: [{ montant_prevu: 80000, montant_facture: 80000 }],
  });
  assert.strictEqual(d.marge_projetee, 20000);
  assert.strictEqual(d.marge_projetee_pct, 20);
});

test('agregation — un projet dont une division n a pas de revenu est signale partiel', () => {
  const divisions = [
    computeDivision({ code_division: 'A', montant_initial: 100000, budget_revenus: 120000, cout_reel_hors_mo: 100000, bcs: [{ montant_prevu: 100000, montant_facture: 100000 }] }),
    computeDivision({ code_division: 'B', montant_initial: 50000, budget_revenus: 0, cout_reel_hors_mo: 50000, bcs: [{ montant_prevu: 50000, montant_facture: 50000 }] }),
  ];
  const p = agregerProjet(divisions);
  assert.strictEqual(p.marge_partielle, true);
  assert.strictEqual(p.divisions_sans_revenu, 1);
  assert.strictEqual(p.budget_revenus, 120000);
  assert.strictEqual(p.prevision_total, 150000);
});

test('agregation — projet complet a 20 % de marge', () => {
  const divisions = [
    computeDivision({ code_division: 'A', montant_initial: 400000, budget_revenus: 500000, cout_reel_hors_mo: 400000, bcs: [{ montant_prevu: 400000, montant_facture: 400000 }] }),
    computeDivision({ code_division: 'B', montant_initial: 400000, budget_revenus: 500000, cout_reel_hors_mo: 400000, bcs: [{ montant_prevu: 400000, montant_facture: 400000 }] }),
  ];
  const p = agregerProjet(divisions);
  assert.strictEqual(p.marge_projetee, 200000);
  assert.strictEqual(p.marge_projetee_pct, 20);
  assert.strictEqual(p.marge_partielle, false);
  assert.strictEqual(p.statut, 'vert');
});

test('agregation — projet vide ne plante pas', () => {
  const p = agregerProjet([]);
  assert.strictEqual(p.nb_divisions, 0);
  assert.strictEqual(p.marge_projetee, null);
  assert.strictEqual(p.statut, 'inconnu');
});

test('seuils CRC — 3 % vert, 8 % jaune, au-dela rouge', () => {
  assert.strictEqual(statutEcart(2.9), 'vert');
  assert.strictEqual(statutEcart(3), 'vert');
  assert.strictEqual(statutEcart(7.9), 'jaune');
  assert.strictEqual(statutEcart(8), 'jaune');
  assert.strictEqual(statutEcart(8.1), 'rouge');
  assert.strictEqual(statutEcart(null), 'inconnu');
});
