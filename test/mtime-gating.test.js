// Gating incrémental par mtime — logique aChange/marquer/sauver (fichiers temporaires, aucun réseau).
// Lancer : node test/mtime-gating.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-dbf-'));
const etatFile = path.join(dir, 'etat.json');
process.env.AVANTAGE_DBF_DIR = dir;
process.env.SYNC_STATE_FILE = etatFile;
process.env.INCREMENTAL_MTIME = 'true';

const m = require('../src/services/moniteurFichiers');

let echecs = 0;
function check(nom, reel, attendu) {
  const ok = JSON.stringify(reel) === JSON.stringify(attendu);
  if (!ok) { echecs++; console.log('  ÉCHEC ' + nom + ' — attendu ' + JSON.stringify(attendu) + ', obtenu ' + JSON.stringify(reel)); }
  else console.log('  ok    ' + nom + ' = ' + JSON.stringify(reel));
}
function ecrire(table, contenu) {
  fs.writeFileSync(path.join(dir, table + '.DBF'), contenu);
}
function toucher(table, mtimeMs) {
  const p = path.join(dir, table + '.DBF');
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
}

console.log('--- mtime gating ---');
ecrire('TRANS', 'v1'); toucher('TRANS', 1_000_000_000_000);
ecrire('FACTMA', 'v1'); toucher('FACTMA', 1_000_000_000_000);

let etat = m.charger();
check('1er passage : TRANS a changé (repère vide)', m.aChange(etat, ['TRANS']), true);
check('1er passage : FACTMA a changé', m.aChange(etat, ['FACTMA']), true);

// Après un cycle propre, on mémorise les repères.
m.marquer(etat, ['TRANS', 'FACTMA']);
m.sauver(etat);

etat = m.charger();
check('2e passage : TRANS inchangé', m.aChange(etat, ['TRANS']), false);
check('2e passage : FACTMA inchangé', m.aChange(etat, ['FACTMA']), false);

// Avantage réécrit TRANS (mtime plus récent) → doit redevenir « à retraiter ».
toucher('TRANS', 1_000_000_060_000);
check('TRANS modifié → à retraiter', m.aChange(etat, ['TRANS']), true);
check('FACTMA toujours inchangé', m.aChange(etat, ['FACTMA']), false);

// Groupe : au moins une source du groupe a changé → true.
check('groupe [TRANS,FACTMA] → true (TRANS a bougé)', m.aChange(etat, ['TRANS', 'FACTMA']), true);

// Fichier absent → considéré comme « à retraiter » (mtime 0).
check('table absente → à retraiter', m.aChange(etat, ['CONFIT']), true);

// Désactivation globale → toujours true.
process.env.INCREMENTAL_MTIME = 'false';
check('gating désactivé → toujours true', m.aChange(etat, ['FACTMA']), true);
process.env.INCREMENTAL_MTIME = 'true';

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
console.log(echecs ? '\n' + echecs + ' ÉCHEC(S)' : '\nTous les tests passent');
process.exit(echecs ? 1 : 0);
