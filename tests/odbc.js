// Lecture directe de la BD Avantage: resolution des colonnes, filtre pousse
// dans le SQL, et equivalence stricte avec la source export Excel.
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'avantage-odbc-'));
process.env.EXPORT_DIR = DIR;
process.env.BASE44_API_KEY = 'test';
process.env.BASE44_APP_ID = 'test';
process.env.WATCH_EXPORT = 'false';
process.env.AVANTAGE_SOURCE = 'odbc';
process.env.ODBC_DSN = 'AVANTAGE_TEST';

let echecs = 0;
function check(nom, reel, attendu) {
  const ok = JSON.stringify(reel) === JSON.stringify(attendu);
  if (!ok) { echecs++; console.log('  ECHEC ' + nom + ' — attendu ' + JSON.stringify(attendu) + ', obtenu ' + JSON.stringify(reel)); }
  else console.log('  ok    ' + nom + ' = ' + JSON.stringify(reel));
}

// ---------- Memes donnees que tests/run.js, mais en tables ----------
const TABLES = {
  CONTRA: [
    { CONUM: '23020', CONOM: 'Caserne Wemotaci', COCLINOM: 'Ville', COSTT: 'actif', COFADATER: '2026-01-01', COFADATEP: '2026-12-31', COSOLDER: '0', COPRCPROF: '0' },
    { CONUM: '24011', CONOM: 'Ecole Test', COCLINOM: 'CSS', COSTT: 'actif', COFADATER: '', COFADATEP: '', COSOLDER: '0', COPRCPROF: '0' },
  ],
  FACTMA: [
    { FFNOFACT: 'F-900', FFCONT: '23020', FFVENTE: 'Ville', FFDATE: '2026-02-01', FFDATEP: '', FFTOTDU: '80000', FFSOLDE: '80000', FFMNTRET: '4000' },
  ],
  ACTIVE: [
    { ACNUM: '02100.00', ACDESC: 'Excavation' },
    { ACNUM: '03300.00', ACDESC: 'Beton' },
    { ACNUM: '06101.00', ACDESC: "Main d'oeuvre" },
  ],
  CONPRE: [
    { CPCONUM: '0000023020', CPACT: '02100.00', CPMNT: '100000' },
    { CPCONUM: '0000023020', CPACT: '06101.00', CPMNT: '50000' },
    { CPCONUM: '0000024011', CPACT: '02100.00', CPMNT: '7000' },
  ],
  CONACT: [{ CACONUM: '23020', CAANUM: '02100', CAFACT: '80000', CAVENIR: '0' }],
  TRANS: [
    { TRCONUM: '23020', TRGL: '33200', TRDATE: '2026-01-15', TRJOURNAL: 'P000123', TRMNT: '60000', TRACT: '02100.00' },
    { TRCONUM: '23020', TRGL: '52000', TRDATE: '2026-01-20', TRJOURNAL: 'E000045', TRMNT: '20000', TRACT: '06101.00' },
    { TRCONUM: '23020', TRGL: '11000', TRDATE: '2026-01-25', TRJOURNAL: 'R000099', TRMNT: '90000', TRACT: '02100.00' },
    { TRCONUM: '23020', TRGL: '52000', TRDATE: '2026-01-21', TRJOURNAL: 'E000045', TRMNT: '5000', TRACT: '03300.00' },
  ],
  PYBBIL: [{
    PYNOSEQ: '1001', PYDATE: '2026-02-01', PYNOFACT: 'FACT-1', PYDESC: 'Achat beton', PYTOT: '11497.5',
    PYCONUM: '23020', PYNOCMD: '123456789', PYNOMFOURN: 'Beton Inc',
    PYGL1: '33200', PYMNT1: '10000', PYGL2: '21340', PYMNT2: '1497.5', PYGL3: '', PYMNT3: '0',
  }],
  COMITE: [{ CINOCMD: '123456789', CIACT: '03300.00' }],
  COMMAN: [{ CMCONUM: '23020', CMNOSEQ: '555', CMNOCMD: '123456789', CMFOURN: 'F001', CMNOMFOURN: 'Beton Inc', CMSSTOT: '25000', CMSTATUT: '0' }],
};

// Export Excel equivalent, pour tester le repli quand la BD tombe
const sheets = {
  ACTIVE: [['Code', 'Description'], ['02100.00', 'Excavation'], ['03300.00', 'Beton'], ['06101.00', "Main d'oeuvre"]],
  CONPRE: [['Numero projet', 'Code activite', 'Montant previsionnel'],
           ['0000023020', '02100.00', '100000'], ['0000023020', '06101.00', '50000']],
  CONACT: [['projet', 'act', 'pct', 'venir', 'facture'], ['23020', '02100', '0', '0', '80000']],
  TRANS:  [['projet', 'gl', 'date', 'journal', 'montant', 'act'],
           ['23020', '33200', '2026-01-15', 'P000123', '60000', '02100.00'],
           ['23020', '52000', '2026-01-20', 'E000045', '20000', '06101.00'],
           ['23020', '11000', '2026-01-25', 'R000099', '90000', '02100.00'],
           ['23020', '52000', '2026-01-21', 'E000045', '5000',  '03300.00']],
  PYBBIL: [new Array(50).fill('h'), (() => {
    const r = new Array(50).fill('');
    r[0] = '1001'; r[1] = '2026-02-01'; r[4] = 'FACT-1'; r[5] = 'Achat beton'; r[6] = '11497.5';
    r[8] = '33200'; r[9] = '10000'; r[10] = '21340'; r[11] = '1497.5';
    r[33] = '23020'; r[44] = '123456789'; r[48] = 'Beton Inc';
    return r;
  })()],
  COMITE: [new Array(20).fill('h'), (() => { const r = new Array(20).fill(''); r[16] = '123456789'; r[17] = '03300'; return r; })()],
  CONTRA: [['CONUM', 'CONOM', 'COSTT'], ['23020', 'Caserne Wemotaci', 'actif'], ['24011', 'Ecole Test', 'actif']],
  FACTMA: [['FFNOFACT', 'FFCONT', 'FFVENTE', 'FFDATE', 'FFTOTDU', 'FFSOLDE', 'FFMNTRET'],
           ['F-900', '23020', 'Ville', '2026-02-01', '80000', '80000', '4000']],
  COMMAN: [['Numero de projet', 'Sequentiel', 'Sequentiel de commande', 'Numero de fournisseur', 'Nom du fournisseur', 'Sous-total', 'Statut'],
           ['23020', '555', '123456789', 'F001', 'Beton Inc', '25000', '0']],
};
const wb = XLSX.utils.book_new();
for (const [nom, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), nom);
XLSX.writeFile(wb, path.join(DIR, 'export.xlsx'));

const faux = require('./fake-odbc').install(TABLES);
const store = { Projet: [], ControleBudgetaire: [], BonDeCommande: [], TransactionAvantage: [], FactureClient: [] };
store.Projet.push({ _id: 'p1', code_projet: 'P23020', nom: 'Caserne Wemotaci', statut: 'actif' });
require('./mock-base44').install(store);

(async () => {
  // Resolution des colonnes contre un schema Avantage plausible
  const { inspecter } = require('../src/services/dbInspect');
  const rapport = await inspecter();
  console.log('\n--- Resolution du schema ---');
  check('toutes les tables resolues', rapport.ok, true);
  check('transactions', rapport.tables.transactions.mapping,
    { projet: 'TRCONUM', gl: 'TRGL', date: 'TRDATE', journal: 'TRJOURNAL', montant: 'TRMNT', activite: 'TRACT' });
  check('paires GL/montant detectees', rapport.tables.facturesFournisseur.ventilation,
    [{ gl: 'PYGL1', montant: 'PYMNT1' }, { gl: 'PYGL2', montant: 'PYMNT2' }, { gl: 'PYGL3', montant: 'PYMNT3' }]);
  check('bons de commande', rapport.tables.commandes.mapping.sous_total, 'CMSSTOT');

  console.log('\n--- Sync depuis la BD ---');
  const { runFullSync } = require('../src/services/fullSync');
  const r = await runFullSync({ codes: ['P23020'] });
  check('source utilisee', r.source, 'odbc');
  check('sync ok', [r.ok, r.erreurs], [true, 0]);

  const filtre = faux.sqlVu.find(s => s.includes('FROM "TRANS"') && s.includes(' IN ('));
  check('filtre projet pousse dans le SQL', !!filtre, true);
  check('table TRANS non relue en entier', faux.sqlVu.filter(s => s === 'SELECT "TRCONUM", "TRGL", "TRDATE", "TRJOURNAL", "TRMNT", "TRACT" FROM "TRANS"').length, 0);

  const cb = Object.fromEntries(store.ControleBudgetaire.map(x => [x.code_division, x]));
  check('divisions', Object.keys(cb).sort(), ['02100', '03300', '06101']);
  check('02100 budget / engage / facture', [cb['02100'].montant_initial, cb['02100'].engage, cb['02100'].facture], [100000, 60000, 80000]);
  check('06101 en mo_total', [cb['06101'].engage, cb['06101'].mo_total], [0, 20000]);
  check('03300 hors budget', [cb['03300'].montant_initial, cb['03300'].engage], [0, 5000]);
  check('nom de division lu dans ACTIVE', cb['02100'].nom_division, 'Excavation');

  const tr = Object.fromEntries(store.TransactionAvantage.map(x => [x.numero_journal, x]));
  check('transactions', Object.keys(tr).sort(), ['E000045', 'E000045-03300', 'P1001']);
  check('montant net hors taxes', tr['P1001'].montant, 10000);
  check('facture rattachee au BC', tr['P1001'].bon_de_commande_id, store.BonDeCommande[0]._id);
  check('facture rattachee a la division', tr['P1001'].controle_budgetaire_id, cb['03300']._id);

  // Equivalence avec la source Excel sur les memes donnees
  console.log('\n--- Equivalence BD / export Excel ---');
  const { buildDataset } = require('../src/services/dataset');
  const odbcSrc = require('../src/sources/odbc-source');
  const xlsxSrc = require('../src/sources/xlsx-source');
  xlsxSrc.prepare(true);
  const dsDb = buildDataset(await odbcSrc.loadDetail(['23020']));
  const dsXl = buildDataset(await xlsxSrc.loadDetail(['23020']));
  const sansMeta = d => ({ actMap: d.actMap, commandeDivMap: d.commandeDivMap, compte: d.compte });
  check('memes activites et BC', sansMeta(dsDb).commandeDivMap, sansMeta(dsXl).commandeDivMap);
  check('memes compteurs de lignes', dsDb.compte, dsXl.compte);
  const { rowsFor } = require('../src/services/dataset');
  check('memes transactions', rowsFor(dsDb.index.transactions, '23020'), rowsFor(dsXl.index.transactions, '23020'));
  check('memes factures fournisseurs', rowsFor(dsDb.index.facturesFournisseur, '23020'), rowsFor(dsXl.index.facturesFournisseur, '23020'));
  check('memes bons de commande', rowsFor(dsDb.index.commandes, '23020'), rowsFor(dsXl.index.commandes, '23020'));

  // Repli sur l'export Excel si la BD est injoignable
  console.log('\n--- Repli si la BD tombe ---');
  faux.restore();
  require('./fake-odbc').install(TABLES, { connexionEchoue: 'driver introuvable' });
  delete require.cache[require.resolve('../src/sources/odbc-source')];
  delete require.cache[require.resolve('../src/sources')];
  delete require.cache[require.resolve('../src/services/fullSync')];
  const { runFullSync: run2 } = require('../src/services/fullSync');
  const r2 = await run2({ codes: ['P23020'], force: true });
  check('bascule sur xlsx', r2.source, 'xlsx');
  check('sync quand meme reussi', r2.ok, true);
  check('repli signale', typeof r2.repli_xlsx === 'string' && r2.repli_xlsx.includes('driver introuvable'), true);

  fs.rmSync(DIR, { recursive: true, force: true });
  try { fs.unlinkSync(require('../src/config').STATE_FILE); } catch (e) {}
  console.log(echecs ? '\n' + echecs + ' ECHEC(S)' : '\nTous les tests passent');
  process.exit(echecs ? 1 : 0);
})();
