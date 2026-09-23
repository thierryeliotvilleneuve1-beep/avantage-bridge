// Gating incrémental par date de modification (mtime) des fichiers .DBF d'Avantage.
//
// Idée : un fichier .DBF ne change QUE lorsqu'Avantage y écrit. Avant chaque étape du cycle,
// on compare la date de modif du/des fichier(s) source à celle du dernier sync réussi. Si rien
// n'a bougé → on saute l'étape (« cycle tranquille »). Combiné aux écritures déjà différentielles,
// le pont ne fait quasiment rien quand Avantage n'a pas changé.
//
// Robuste : on ne mémorise la nouvelle date d'une source QU'APRÈS le succès de son étape
// (sans erreur). Une étape en échec n'avance pas son repère → elle sera retentée au cycle suivant.
// LECTURE SEULE (stat de fichier). Désactivable via INCREMENTAL_MTIME=false.

const fs = require('fs');
const path = require('path');
const dbf = require('../db/lecteurDbf');

function repertoire() {
  if (process.env.AVANTAGE_DBF_DIR) return path.resolve(process.env.AVANTAGE_DBF_DIR);
  return process.platform === 'win32' ? 'A:\\AVA01' : '';
}

function actif() { return process.env.INCREMENTAL_MTIME !== 'false'; }

const CHEMIN_ETAT = process.env.SYNC_STATE_FILE || path.resolve(__dirname, '../../.sync-etat-fichiers.json');

function charger() {
  try { return JSON.parse(fs.readFileSync(CHEMIN_ETAT, 'utf8')); } catch (e) { return {}; }
}
function sauver(etat) {
  try { fs.writeFileSync(CHEMIN_ETAT, JSON.stringify(etat, null, 2)); return true; } catch (e) { return false; }
}

// Date de modif (ms entiers) du .DBF d'une table ; 0 si absent/illisible.
function mtimeDe(table) {
  try {
    const f = dbf.trouverFichier(repertoire(), table);
    if (!f) return 0;
    return Math.floor(fs.statSync(f).mtimeMs);
  } catch (e) { return 0; }
}

// Une source doit-elle être retraitée ? true si gating inactif, mtime inconnu (0), ou changé.
function aChange(etat, tables) {
  if (!actif()) return true;
  const arr = Array.isArray(tables) ? tables : [tables];
  return arr.some(t => { const m = mtimeDe(t); return !m || etat[t] !== m; });
}

// Mémorise les mtimes courants des sources (à appeler après le succès d'une étape).
function marquer(etat, tables) {
  const arr = Array.isArray(tables) ? tables : [tables];
  for (const t of arr) { const m = mtimeDe(t); if (m) etat[t] = m; }
}

// Aperçu lisible : date de modif humaine par table suivie.
function apercu(tables) {
  const out = {};
  for (const t of tables) { const m = mtimeDe(t); out[t] = m ? new Date(m).toISOString() : 'absent'; }
  return out;
}

module.exports = { actif, charger, sauver, mtimeDe, aChange, marquer, apercu, repertoire, CHEMIN_ETAT };
