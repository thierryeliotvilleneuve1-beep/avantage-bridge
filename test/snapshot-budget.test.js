// Snapshot budgétaire : agrégation par projet (WIP, récupération, ratio) + semaine ISO.
// Lancer : node test/snapshot-budget.test.js

const sb = require('../src/services/snapshotBudget');

let echecs = 0;
function check(nom, reel, attendu) {
  const ok = JSON.stringify(reel) === JSON.stringify(attendu);
  if (!ok) { echecs++; console.log('  ÉCHEC ' + nom + ' — attendu ' + JSON.stringify(attendu) + ', obtenu ' + JSON.stringify(reel)); }
  else console.log('  ok    ' + nom + ' = ' + JSON.stringify(reel));
}

// Projet P1 (actif) : 2 divisions réelles + 1 ligne ODC (ignorée).
// Projet P2 (terminé) : ignoré en entier.
const projets = [
  { _id: 'p1', code_projet: 'P26004', nom: 'École X', statut: 'actif' },
  { _id: 'p2', code_projet: 'P25010', nom: 'Ancien', statut: 'termine' },
];
const divisions = [
  { projet_id: 'p1', code_division: '03100', nom_division: 'Béton', montant_initial: 100000, depense: 70000, engage: 25000, mo_total: 30000, facture: 60000, budget_revenus: 110000 }, // cout 95k, ratio .95 → risque
  { projet_id: 'p1', code_division: '06100', nom_division: 'Charpente', montant_revise: 50000, montant_initial: 40000, depense: 20000, engage: 5000, mo_total: 8000, facture: 30000, budget_revenus: 55000 }, // budget 50k (révisé prime), cout 25k, ratio .5
  { projet_id: 'p1', code_division: 'ODC-1', nom_division: 'Ordre', type_ligne: 'odc', montant_initial: 999999, depense: 999999 }, // ignoré
  { projet_id: 'p2', code_division: '03100', nom_division: 'Béton', montant_initial: 100000, depense: 50000, engage: 0 }, // projet terminé → ignoré
];

console.log('--- Agrégation (semaine figée) ---');
const photos = sb.calculer(divisions, projets, '2026-W38');
check('un seul projet retenu', photos.length, 1);
const p = photos[0];
check('code projet', p.code_projet, 'P26004');
check('budget = 100k + 50k(révisé)', p.budget, 150000);
check('dépense = 90k', p.depense, 90000);
check('engagé = 30k', p.engage, 30000);
check('coût = dépense+engagé = 120k', p.cout, 120000);
check('récupération = budget−coût = 30k', p.recuperation, 30000);
check('WIP = dépense−facturé = 90k−90k = 0', p.wip, 0);
check('ratio coût = 120k/150k = 0.8', p.ratio_cout, 0.8);
check('mo agrégée = 38k', p.mo, 38000);
check('1 division à risque (03100 ≥ 90%)', p.nb_divisions_risque, 1);
check('semaine transmise', p.semaine, '2026-W38');

console.log('\n--- Semaine ISO ---');
check('jeudi 2026-09-17 → W38', sb.semaineISO(new Date('2026-09-17T12:00:00Z')), '2026-W38');
check('1er janvier 2026 (jeudi) → W01', sb.semaineISO(new Date('2026-01-01T12:00:00Z')), '2026-W01');

console.log('\n--- WIP positif (sous-facturation) ---');
const d2 = [{ projet_id: 'p1', code_division: '03100', nom_division: 'Béton', montant_initial: 100000, depense: 80000, engage: 0, facture: 45000 }];
const ph2 = sb.calculer(d2, projets, '2026-W38');
check('WIP = 80k−45k = 35k (cash immobilisé)', ph2[0].wip, 35000);

console.log(echecs ? '\n' + echecs + ' ÉCHEC(S)' : '\nTous les tests passent');
process.exit(echecs ? 1 : 0);
