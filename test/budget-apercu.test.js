// Aperçu budgétaire : reconstruire le « Suivi de projet » depuis CONPRE/TRANS/CONACT.
// Valide la mécanique (résolution des champs, classement coûts/revenus, journaux) sur
// des .DBF synthétiques. La justesse finale se valide contre l'écran Avantage réel.

const fs = require('fs');
const os = require('os');
const path = require('path');
const aide = require('./aide-dbf');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'apercu-'));
process.env.AVANTAGE_DBF_DIR = DIR;
const ecrire = aide.pour(DIR);

let echecs = 0;
const check = (nom, reel, att) => {
  const ok = JSON.stringify(reel) === JSON.stringify(att);
  if (!ok) { echecs++; console.log('  ÉCHEC ' + nom + ' attendu ' + JSON.stringify(att) + ' obtenu ' + JSON.stringify(reel)); }
  else console.log('  ok    ' + nom + ' = ' + JSON.stringify(reel));
};

// CONPRE : budget par division + poste GL (33xxx coût, 31xxx revenu)
ecrire('CONPRE.DBF', [
  { nom: 'CPCONUM', type: 'C', longueur: 10 }, { nom: 'CPACT', type: 'C', longueur: 6 },
  { nom: 'CPPOSTE', type: 'C', longueur: 6 }, { nom: 'CPMNT', type: 'N', longueur: 14, decimales: 2 },
], [
  { CPCONUM: '0000026004', CPACT: '00400', CPPOSTE: '33200', CPMNT: '120261.45' },
  { CPCONUM: '0000026004', CPACT: '00400', CPPOSTE: '31100', CPMNT: '132287.60' },
  { CPCONUM: '0000026004', CPACT: '00401', CPPOSTE: '33200', CPMNT: '20277.50' },
  { CPCONUM: '0000099999', CPACT: '00400', CPPOSTE: '33200', CPMNT: '999999.00' }, // autre projet
]);

// TRANS : dépense (P/E/B), engagé (C), revenu (R exclu des coûts)
ecrire('TRANS.DBF', [
  { nom: 'TCONUM', type: 'C', longueur: 10 }, { nom: 'TNOGL', type: 'C', longueur: 6 },
  { nom: 'TNOSEQ', type: 'C', longueur: 10 }, { nom: 'TMNT', type: 'N', longueur: 14, decimales: 2 },
  { nom: 'TANUM', type: 'C', longueur: 6 },
], [
  { TCONUM: '0000026004', TNOGL: '33200', TNOSEQ: 'P000001', TMNT: '15719.38', TANUM: '00400' },
  { TCONUM: '0000026004', TNOGL: '52000', TNOSEQ: 'E000002', TMNT: '10000.00', TANUM: '00401' },
  { TCONUM: '0000026004', TNOGL: '33500', TNOSEQ: 'C000003', TMNT: '50000.00', TANUM: '00400' }, // engagé
  { TCONUM: '0000026004', TNOGL: '31100', TNOSEQ: 'R000004', TMNT: '92601.32', TANUM: '00400' }, // revenu, exclu
  { TCONUM: '0000026004', TNOGL: '21340', TNOSEQ: 'P000005', TMNT: '2000.00',  TANUM: '00400' }, // taxe, exclue
]);

// CONACT : facturé + coûts à venir
ecrire('CONACT.DBF', [
  { nom: 'CACONUM', type: 'C', longueur: 10 }, { nom: 'CAANUM', type: 'C', longueur: 6 },
  { nom: 'CAFACT', type: 'N', longueur: 14, decimales: 2 }, { nom: 'CAVENIR', type: 'N', longueur: 14, decimales: 2 },
], [
  { CACONUM: '0000026004', CAANUM: '00400', CAFACT: '92601.32', CAVENIR: '0.00' },
  { CACONUM: '0000026004', CAANUM: '00401', CAFACT: '22305.25', CAVENIR: '0.00' },
]);

const { apercu } = require('../src/sources/budgetDbf');
const r = apercu('P26004');
const parDiv = Object.fromEntries(r.divisions.map(d => [d.division, d]));

console.log('--- Aperçu P26004 ---');
check('division 00400 budget coût', parDiv['00400'].budget_cout, 120261.45);
check('division 00400 budget revenu', parDiv['00400'].budget_revenu, 132287.60);
check('division 00400 dépense (P, taxe exclue)', parDiv['00400'].depense, 15719.38);
check('division 00400 engagé (journal C)', parDiv['00400'].engage, 50000);
check('division 00400 facturé (CONACT)', parDiv['00400'].facture, 92601.32);
check('division 00401 dépense (E)', parDiv['00401'].depense, 10000);
check('revenu R non compté en dépense', r.divisions.every(d => d.depense >= 0), true);
check('autre projet 99999 exclu', !!parDiv['00400'] && r.totaux.budget_cout, 140538.95); // 120261.45 + 20277.50
check('total facturé', r.totaux.facture, 114906.57); // 92601.32 + 22305.25

fs.rmSync(DIR, { recursive: true, force: true });
console.log(echecs ? '\n' + echecs + ' ÉCHEC(S)' : '\nTous les tests passent');
process.exit(echecs ? 1 : 0);
