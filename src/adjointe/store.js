// État et journal d'audit — fichiers plats, aucune dépendance.
// Le journal est en ajout seul : toute action de l'Adjointe y laisse une trace (Mandat §Journal).
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const FICHIER_ETAT = path.join(DATA_DIR, 'etat.json');
const FICHIER_JOURNAL = path.join(DATA_DIR, 'journal.jsonl');

function assurerDossier() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function lireEtat() {
  assurerDossier();
  if (!fs.existsSync(FICHIER_ETAT)) {
    return { derniere_execution: null, elements: {}, compteurs: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(FICHIER_ETAT, 'utf8'));
  } catch (e) {
    return { derniere_execution: null, elements: {}, compteurs: {}, erreur_lecture: e.message };
  }
}

function ecrireEtat(etat) {
  assurerDossier();
  const tmp = FICHIER_ETAT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(etat, null, 2), 'utf8');
  fs.renameSync(tmp, FICHIER_ETAT);
}

function journaliser(entree) {
  assurerDossier();
  const ligne = JSON.stringify({ ts: new Date().toISOString(), ...entree });
  fs.appendFileSync(FICHIER_JOURNAL, ligne + '\n', 'utf8');
}

function lireJournal(limite = 200) {
  assurerDossier();
  if (!fs.existsSync(FICHIER_JOURNAL)) return [];
  const lignes = fs.readFileSync(FICHIER_JOURNAL, 'utf8').trim().split('\n').filter(Boolean);
  return lignes.slice(-limite).reverse().map((l) => {
    try { return JSON.parse(l); } catch (e) { return { ts: null, erreur: 'ligne illisible' }; }
  });
}

module.exports = { lireEtat, ecrireEtat, journaliser, lireJournal, FICHIER_ETAT, FICHIER_JOURNAL };
