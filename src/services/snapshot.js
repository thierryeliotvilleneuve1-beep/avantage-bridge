const { apiGetAll, idOf } = require('../writers/base44-writer');

const STATUTS_INACTIFS = ['ferme', 'fermé', 'termine', 'terminé', 'archive', 'archivé', 'inactif', 'annule', 'annulé', 'complete', 'complété'];

function normalise(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Code Avantage numerique a partir d'un code_projet Manoeuvre (P23020 -> 23020).
function codeAvantage(codeProjet) {
  const m = (codeProjet || '').toString().match(/\d{3,}/);
  return m ? m[0] : null;
}

function findProjet(projets, code) {
  return projets.find(p => {
    const cp = (p.code_projet || '').toUpperCase();
    return cp === 'P' + code || cp.includes(code) || cp === code;
  });
}

function estActif(p) {
  return !STATUTS_INACTIFS.includes(normalise(p.statut));
}

// Un seul chargement des entites Base44 pour tout le cycle de sync.
async function loadSnapshot(entities) {
  const wanted = entities || ['Projet', 'ControleBudgetaire', 'BonDeCommande', 'TransactionAvantage'];
  const snap = {};
  for (const e of wanted) {
    snap[e] = await apiGetAll(e);
  }
  return snap;
}

// Index { valeur_de_cle: id } pour les enregistrements d'un projet donne.
function indexBy(records, projetId, keyField) {
  const map = {};
  for (const x of records) {
    if (x.projet_id !== projetId) continue;
    const k = x[keyField];
    if (k) map[k] = idOf(x);
  }
  return map;
}

module.exports = { loadSnapshot, findProjet, estActif, codeAvantage, indexBy, normalise };
