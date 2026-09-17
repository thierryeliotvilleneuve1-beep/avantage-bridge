// Test de bout en bout du sync, sans reseau (Base44 simule en memoire).
// Usage: node tests/run.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'avantage-test-'));
process.env.EXPORT_DIR = DIR;
process.env.BASE44_API_KEY = 'test';
process.env.BASE44_APP_ID = 'test';
process.env.WATCH_EXPORT = 'false';
process.env.SYNC_PROJETS = 'auto';

let echecs = 0;
function check(nom, reel, attendu) {
  const ok = JSON.stringify(reel) === JSON.stringify(attendu);
  if (!ok) { echecs++; console.log('  ECHEC ' + nom + ' — attendu ' + JSON.stringify(attendu) + ', obtenu ' + JSON.stringify(reel)); }
  else console.log('  ok    ' + nom + ' = ' + JSON.stringify(reel));
}

// ---------- fixtures ----------
function pybbilRow() {
  const r = new Array(50).fill('');
  r[0] = '1001'; r[1] = '2026-02-01'; r[4] = 'FACT-1'; r[5] = 'Achat beton'; r[6] = '11497.5';
  r[8] = '33200'; r[9] = '10000';      // ligne de cout
  r[10] = '21340'; r[11] = '1497.5';   // taxe -> exclue du net
  r[33] = '23020'; r[44] = '123456789'; r[48] = 'Beton Inc';
  return r;
}
function comiteRow() {
  const r = new Array(20).fill('');
  r[16] = '123456789'; r[17] = '03300';
  return r;
}
const sheets = {
  ACTIVE: [['Code', 'Description'], ['02100.00', 'Excavation'], ['03300.00', 'Beton'], ['06101.00', "Main d'oeuvre"]],
  CONPRE: [['Numero projet', 'Code activite', 'Montant previsionnel'],
           ['0000023020', '02100.00', '100000'], ['0000023020', '06101.00', '50000'], ['0000024011', '02100.00', '7000']],
  CONACT: [['projet', 'act', 'pct', 'venir', 'facture'], ['23020', '02100', '0', '0', '80000']],
  TRANS:  [['projet', 'gl', 'date', 'journal', 'montant', 'act'],
           ['23020', '33200', '2026-01-15', 'P000123', '60000', '02100.00'],
           ['23020', '52000', '2026-01-20', 'E000045', '20000', '06101.00'],
           ['23020', '11000', '2026-01-25', 'R000099', '90000', '02100.00'],
           ['23020', '52000', '2026-01-21', 'E000045', '5000',  '03300.00']],
  PYBBIL: [new Array(50).fill('h'), pybbilRow()],
  COMITE: [new Array(20).fill('h'), comiteRow()],
  CONTRA: [['CONUM', 'CONOM', 'COSTT'], ['23020', 'Caserne Wemotaci', 'actif'], ['24011', 'Ecole Test', 'actif']],
  FACTMA: [['FFNOFACT', 'FFCONT', 'FFVENTE', 'FFDATE', 'FFTOTDU', 'FFSOLDE', 'FFMNTRET'],
           ['F-900', '23020', 'Ville', '2026-02-01', '80000', '80000', '4000']],
  COMMAN: [['Numero de projet', 'Sequentiel', 'Sequentiel de commande', 'Numero de fournisseur', 'Nom du fournisseur', 'Sous-total', 'Statut'],
           ['23020', '555', '123456789', 'F001', 'Beton Inc', '25000', '0']],
};
const wb = XLSX.utils.book_new();
for (const [nom, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), nom);
XLSX.writeFile(wb, path.join(DIR, 'export.xlsx'));

// ---------- Base44 simule ----------
const store = { Projet: [], ControleBudgetaire: [], BonDeCommande: [], TransactionAvantage: [], FactureClient: [] };
// 600 projets: force la pagination (un GET limit=500 ne voyait pas P23020 en position 550)
for (let i = 0; i < 600; i++) store.Projet.push({ _id: 'p' + i, code_projet: 'PX' + String(i).padStart(4, '0'), nom: 'Filler', statut: 'actif' });
store.Projet[550] = { _id: 'p550', code_projet: 'P23020', nom: 'Caserne Wemotaci', statut: 'actif' };
store.Projet[560] = { _id: 'p560', code_projet: 'P24011', nom: 'Ecole Test', statut: 'actif' };
const calls = require('./mock-base44').install(store);

(async () => {
  const { runFullSync } = require('../src/services/fullSync');

  console.log('\n--- Run 1 : sync complet des projets 23020 et 24011 ---');
  const r1 = await runFullSync({ codes: ['P23020'] });
  check('sync ok', r1.ok, true);
  check('erreurs', r1.erreurs, 0);

  const p = r1.projets[0];
  check('divisions poussees', p.budget.phases, 3);
  check('divisions creees', p.budget.created, 3);

  const cb = Object.fromEntries(store.ControleBudgetaire.map(x => [x.code_division, x]));
  check('02100 budget', cb['02100'].montant_initial, 100000);
  check('02100 engage (TRANS type R exclu)', cb['02100'].engage, 60000);
  check('02100 facture (CONACT)', cb['02100'].facture, 80000);
  check('06101 main-d-oeuvre dans mo_total', [cb['06101'].engage, cb['06101'].mo_total], [0, 20000]);
  check('03300 hors budget cree depuis TRANS', [cb['03300'].montant_initial, cb['03300'].engage], [0, 5000]);

  check('BC crees', p.bc.created, 1);
  check('BC reference', store.BonDeCommande[0].reference_avantage, '123456789');

  check('transactions poussees', p.transactions.total, 3);
  const tr = Object.fromEntries(store.TransactionAvantage.map(x => [x.numero_journal, x]));
  check('PYBBIL montant net (taxe exclue)', tr['P1001'].montant, 10000);
  check('PYBBIL rattache au BC', tr['P1001'].bon_de_commande_id, store.BonDeCommande[0]._id);
  check('PYBBIL rattache a la division 03300', tr['P1001'].controle_budgetaire_id, cb['03300']._id);
  check('journal dedouble sur 2 activites', Object.keys(tr).sort(), ['E000045', 'E000045-03300', 'P1001']);

  check('aucun projet duplique malgre 600 enregistrements', store.Projet.length, 600);
  check('P23020 mis a jour, pas recree', store.Projet[550].nom, 'Caserne Wemotaci');

  console.log('\n--- Run 2 : rien n a change dans Avantage ---');
  const avant = calls.POST + calls.PUT;
  const r2 = await runFullSync({ codes: ['P23020'] });
  check('projet saute', r2.projets[0].skipped, true);
  check('aucune ecriture Base44', calls.POST + calls.PUT - avant, 0);
  check('projets et factures sautes', [r2.etapes.projets.skipped, r2.etapes.factures.skipped], [true, true]);

  console.log('\n--- Run 3 : force ---');
  const r3 = await runFullSync({ codes: ['P23020'], force: true });
  check('divisions mises a jour', r3.projets[0].budget.updated, 3);
  check('aucune division dupliquee', store.ControleBudgetaire.length, 3);
  check('aucune transaction dupliquee', store.TransactionAvantage.length, 3);

  fs.rmSync(DIR, { recursive: true, force: true });
  try { fs.unlinkSync(require('../src/config').STATE_FILE); } catch (e) {}
  console.log(echecs ? '\n' + echecs + ' ECHEC(S)' : '\nTous les tests passent');
  process.exit(echecs ? 1 : 0);
})();
