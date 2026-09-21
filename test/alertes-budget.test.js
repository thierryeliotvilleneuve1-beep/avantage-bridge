// Alertes budgétaires : détection des dépassements/seuils et anti-spam (dédoublonnage).
// Lancer : node test/alertes-budget.test.js

process.env.TEAMS_WEBHOOK_URL = ''; // pas d'envoi réseau pendant le test
const fs = require('fs');
const os = require('os');
const path = require('path');
const ab = require('../src/services/alertesBudget');

let echecs = 0;
function check(nom, reel, attendu) {
  const ok = JSON.stringify(reel) === JSON.stringify(attendu);
  if (!ok) { echecs++; console.log('  ÉCHEC ' + nom + ' — attendu ' + JSON.stringify(attendu) + ', obtenu ' + JSON.stringify(reel)); }
  else console.log('  ok    ' + nom + ' = ' + JSON.stringify(reel));
}

// budget 100k : coût = depense + engage (la MO est déjà dans depense)
const divisions = [
  { id: 'd1', projet_id: 'p1', code_division: '03100', nom_division: 'Béton', montant_initial: 100000, depense: 70000, engage: 45000 }, // 115% → dépassement
  { id: 'd2', projet_id: 'p1', code_division: '04200', nom_division: 'Maçonnerie', montant_initial: 100000, depense: 92000, engage: 0 }, // 92% → avert
  { id: 'd3', projet_id: 'p1', code_division: '06100', nom_division: 'Charpente', montant_initial: 100000, depense: 40000, engage: 10000 }, // 50% → ok
  { id: 'd4', projet_id: 'p1', code_division: 'ODC-1', nom_division: 'Ordre', type_ligne: 'odc', montant_initial: 100000, depense: 200000 }, // ignoré
  { id: 'd5', projet_id: 'p1', code_division: '00000', nom_division: 'Sans budget', montant_initial: 0, depense: 5000 }, // budget nul → ignoré
];

console.log('--- Détection ---');
const b = ab.evaluer(divisions, 0.9);
const parCode = {}; b.forEach(x => { parCode[x.code_division] = x.niveau; });
check('deux écarts détectés', b.length, 2);
check('03100 en dépassement', parCode['03100'], 'depassement');
check('04200 en avertissement', parCode['04200'], 'avert');
check('06100 sain (absent)', parCode['06100'], undefined);
check('ligne ODC ignorée', parCode['ODC-1'], undefined);
check('budget nul ignoré', parCode['00000'], undefined);

console.log('\n--- Anti-spam (dédoublonnage) ---');
// 1er passage : rien de connu → tout est nouveau
const p1 = ab.filtrerNouveaux(b, {});
check('1er passage : 2 à notifier', p1.aNotifier.length, 2);

// 2e passage : état inchangé → rien à renotifier
const p2 = ab.filtrerNouveaux(b, p1.nouvelEtat);
check('2e passage : 0 à notifier', p2.aNotifier.length, 0);

// Aggravation : 04200 passe d'avert à dépassement → re-notifié
const divisions2 = JSON.parse(JSON.stringify(divisions));
divisions2[1].engage = 20000; // 112% → dépassement
const b2 = ab.evaluer(divisions2, 0.9);
const p3 = ab.filtrerNouveaux(b2, p1.nouvelEtat);
check('aggravation 04200 re-notifiée', p3.aNotifier.map(x => x.code_division), ['04200']);

// Retour sous le seuil : 03100 redevient sain → retiré de l'état, re-dépassement futur re-notifie
const divisions3 = JSON.parse(JSON.stringify(divisions));
divisions3[0].depense = 10000; divisions3[0].engage = 0; // 03100 → 10% sain
const b3 = ab.evaluer(divisions3, 0.9);
const p4 = ab.filtrerNouveaux(b3, p1.nouvelEtat);
check('03100 absent du nouvel état', p4.nouvelEtat['p1|d1'], undefined);

console.log('\n--- Persistance état (fichier) ---');
const tmp = path.join(os.tmpdir(), 'alertes-etat-' + Date.now() + '.json');
ab.sauverEtat(p1.nouvelEtat, tmp);
const relu = ab.chargerEtat(tmp);
check('état relu identique', relu, p1.nouvelEtat);
fs.rmSync(tmp, { force: true });

console.log(echecs ? '\n' + echecs + ' ÉCHEC(S)' : '\nTous les tests passent');
process.exit(echecs ? 1 : 0);
