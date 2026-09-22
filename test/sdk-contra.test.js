// Parsing CSV Avantage + logique non destructive de synchro des noms (aucun réseau).
// Lancer : node test/sdk-contra.test.js

const { parseCsv, decouperEnregistrements } = require('../src/services/maintcpClient');
const { estGenerique } = require('../src/services/syncContraNoms');

let echecs = 0;
function check(nom, reel, attendu) {
  const ok = JSON.stringify(reel) === JSON.stringify(attendu);
  if (!ok) { echecs++; console.log('  ÉCHEC ' + nom + ' — attendu ' + JSON.stringify(attendu) + ', obtenu ' + JSON.stringify(reel)); }
  else console.log('  ok    ' + nom + ' = ' + JSON.stringify(reel));
}

console.log('--- parseCsv ---');
// Enregistrement réel (Maison des Jeunes 26008), avec virgule interne dans l'adresse.
const ligne = '"0000026008","Nouvelle maison des jeunes - Manawan","","2026/06/01","","CONSEIL-MA",-4851019.49,0.00,"",0.0000,872720.72,753291.24,0.00,375248.09,87272.07,0.00,87272.07,0.00,0.0709,"251, rue Simon-Ottawa","Manawan","J0K 1M0",F,"0250",F,F,F,"","QC","CAN","AVANTAGE"';
const c = parseCsv(ligne);
check('CONUM (col 0)', c[0], '0000026008');
check('CONOM (col 1)', c[1], 'Nouvelle maison des jeunes - Manawan');
check('COCLI (col 5)', c[5], 'CONSEIL-MA');
check('adresse avec virgule interne', c[19], '251, rue Simon-Ottawa');
check('ville', c[20], 'Manawan');

console.log('\n--- decouperEnregistrements (multi) ---');
const bloc = '"0000000001","service","",... ,"AVANTAGE"\n"0000000002","autre","",... ,"AVANTAGE"';
const recs = decouperEnregistrements(bloc);
check('2 enregistrements', recs.length, 2);
check('1er reconstruit avec AVANTAGE', /,"AVANTAGE"$/.test(recs[0]), true);

console.log('\n--- estGenerique (non destructif) ---');
check('vide → générique', estGenerique('', 'P26008'), true);
check('= code → générique', estGenerique('P26008', 'P26008'), true);
check('numéro seul → générique', estGenerique('26008', 'P26008'), true);
check('numéro paddé → générique', estGenerique('0000026008', 'P26008'), true);
check('vrai nom → PROTÉGÉ', estGenerique('Maison des Jeunes Manawan', 'P26008'), false);

console.log(echecs ? '\n' + echecs + ' ÉCHEC(S)' : '\nTous les tests passent');
process.exit(echecs ? 1 : 0);
