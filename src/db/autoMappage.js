// Déduction automatique des colonnes Avantage, avec validation sur les données.
//
// LE PROBLÈME
// Les exports CSV d'Avantage sont positionnels : le bridge lit PYBBIL par index de colonne
// (33 = numéro de projet, 48 = nom du fournisseur…). En lecture directe dans la base, il
// faut des noms de colonnes que personne n'a documentés.
//
// L'HYPOTHÈSE
// Un export positionnel reflète l'ordre des colonnes de la table. La colonne d'index 33 dans
// le CSV devrait donc être la 34e colonne de la table. C'est une hypothèse forte, pas une
// certitude : on ne s'en sert qu'après l'avoir vérifiée.
//
// LA VÉRIFICATION
// On échantillonne des lignes réelles et on contrôle que chaque colonne contient bien ce
// qu'on attend : une date ressemble à une date, un numéro de projet est numérique, un
// montant est un nombre, un numéro de GL fait quatre ou cinq chiffres. Le mappage n'est
// retenu que si chaque champ obligatoire passe son contrôle. Sinon on retombe sur le CSV
// et on dit précisément ce qui a échoué.

const { TABLES } = require('../config/colonnes-avantage');

// Contrôles par nature de champ. Chacun reçoit les valeurs non vides de l'échantillon et
// retourne la proportion de valeurs plausibles.
const CONTROLES = {
  date: v => /^\s*\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(String(v)),
  montant: v => {
    const s = String(v).replace(/\s/g, '').replace(',', '.');
    return s !== '' && Number.isFinite(parseFloat(s));
  },
  projet: v => {
    const s = String(v).trim();
    return s === '' || /^\d{1,12}$/.test(s) || /^\d+-\d+$/.test(s);
  },
  gl: v => {
    const s = String(v).trim();
    return s === '' || /^\d{4,6}$/.test(s);
  },
  texte: v => String(v).length > 0,
  journal: v => /^[A-Za-z]/.test(String(v).trim()),
};

// Nature attendue de chaque champ logique, par table.
const NATURES = {
  PYBBIL: {
    numeroSequence: 'texte', date: 'date', numeroFourn: 'texte', numeroFacture: 'texte',
    description: 'texte', montantTotal: 'montant', numeroProjet: 'projet',
    numeroCommande: 'projet', nomFournisseur: 'texte',
  },
  TRANS: {
    numeroProjet: 'projet', numeroGl: 'gl', date: 'date',
    journal: 'journal', montant: 'montant', codeActivite: 'projet',
  },
  ACTIVE: { code: 'projet', nom: 'texte' },
  COMITE: { numeroCommande: 'projet', codeActivite: 'projet' },
  FACTMA: {
    numeroFacture: 'texte', numeroProjet: 'projet', client: 'texte', date: 'date',
    montant: 'montant', soldeOuvert: 'montant', retenue: 'montant', noteCredit: 'texte',
  },
  CONTRA: { numeroProjet: 'projet', nom: 'texte', client: 'texte', statut: 'texte' },
};

// Champs dont l'échec invalide tout le mappage. Les autres sont tolérés : une description
// vide ou un numéro de commande absent n'empêchent pas de lire la table.
const OBLIGATOIRES = {
  PYBBIL: ['date', 'montantTotal', 'numeroProjet'],
  TRANS: ['date', 'montant', 'numeroGl', 'journal'],
  ACTIVE: ['code'],
  COMITE: ['numeroCommande', 'codeActivite'],
  FACTMA: ['numeroFacture', 'date', 'montant'],
  CONTRA: ['numeroProjet'],
};

// Seuil de tolérance : les exports hérités contiennent des lignes abîmées, on n'exige pas
// la perfection, mais une nette majorité.
const SEUIL = 0.85;

function proportionValide(valeurs, nature) {
  const test = CONTROLES[nature] || CONTROLES.texte;
  const utiles = valeurs.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
  if (!utiles.length) return null; // colonne vide sur l'échantillon : indécidable
  const bons = utiles.filter(test).length;
  return bons / utiles.length;
}

// Construit le mappage d'une table à partir de ses colonnes réelles.
//
// Deux stratégies, dans cet ordre :
//   1. par NOM — si la configuration propose un nom de colonne et que ce nom existe
//      vraiment dans la table, c'est le signal le plus sûr. La comparaison ignore la casse.
//   2. par POSITION — sinon, on retombe sur l'index de l'export CSV, en supposant que
//      l'export reflète l'ordre des colonnes de la table.
// La validation qui suit tranche : peu importe la stratégie, un champ dont le contenu ne
// correspond pas à sa nature attendue fait échouer le mappage.
function mapperParPosition(nomTable, colonnes) {
  const def = TABLES[nomTable];
  if (!def) return null;
  const noms = colonnes.map(c => c.nom);
  const parMinuscule = {};
  noms.forEach(n => { parMinuscule[String(n).toLowerCase()] = n; });

  const mappage = {};
  const strategies = {};
  const horsBornes = [];

  for (const [champ, spec] of Object.entries(def.colonnes)) {
    // 1. par nom
    if (spec.bd && parMinuscule[String(spec.bd).toLowerCase()]) {
      mappage[champ] = parMinuscule[String(spec.bd).toLowerCase()];
      strategies[champ] = 'nom';
      continue;
    }
    // 2. par position
    const idx = spec.csv;
    if (typeof idx !== 'number') {
      horsBornes.push(champ + ' (aucun nom trouvé et aucune position connue)');
      continue;
    }
    if (idx >= noms.length) { horsBornes.push(champ + ' (index ' + idx + ')'); continue; }
    mappage[champ] = noms[idx];
    strategies[champ] = 'position';
  }

  // Paires GL/montant de PYBBIL : dix paires consécutives à partir de l'index 8.
  let paires = null;
  if (def.pairesGl && Array.isArray(def.pairesGl.bd)) {
    paires = def.pairesGl.bd.filter(p => parMinuscule[String(p.gl).toLowerCase()]);
    if (paires.length) paires = paires.map(p => ({
      gl: parMinuscule[String(p.gl).toLowerCase()],
      montant: parMinuscule[String(p.montant).toLowerCase()] || p.montant,
    }));
  }
  if (def.pairesGl && (!paires || !paires.length)) {
    const p = def.pairesGl;
    paires = [];
    for (let i = 0; i < p.nombre; i++) {
      const iGl = p.csvGlDepart + i * p.csvPas;
      const iMt = p.csvMontantDepart + i * p.csvPas;
      if (iGl >= noms.length || iMt >= noms.length) break;
      paires.push({ gl: noms[iGl], montant: noms[iMt] });
    }
  }

  return { mappage, paires, strategies, nbColonnes: noms.length, horsBornes };
}

// Valide un mappage sur un échantillon de lignes.
function valider(nomTable, mappage, paires, echantillon) {
  const natures = NATURES[nomTable] || {};
  const obligatoires = OBLIGATOIRES[nomTable] || [];
  const details = {};
  const echecs = [];

  for (const [champ, colonne] of Object.entries(mappage)) {
    const nature = natures[champ] || 'texte';
    const valeurs = echantillon.map(l => l[colonne]);
    const prop = proportionValide(valeurs, nature);
    details[champ] = {
      colonne,
      nature,
      taux: prop === null ? null : Math.round(prop * 100),
      verdict: prop === null ? 'colonne vide sur l\'échantillon' : (prop >= SEUIL ? 'ok' : 'incohérent'),
    };
    if (obligatoires.includes(champ) && (prop === null || prop < SEUIL)) {
      echecs.push(champ + ' → ' + colonne + ' : ' + details[champ].verdict +
        (prop === null ? '' : ' (' + Math.round(prop * 100) + ' % de valeurs plausibles)'));
    }
  }

  // Les paires GL doivent au moins contenir des numéros de GL crédibles sur la première.
  if (paires && paires.length) {
    const p0 = paires[0];
    const tGl = proportionValide(echantillon.map(l => l[p0.gl]), 'gl');
    const tMt = proportionValide(echantillon.map(l => l[p0.montant]), 'montant');
    details.paire_gl_1 = {
      colonne: p0.gl + ' / ' + p0.montant,
      nature: 'gl + montant',
      taux: tGl === null ? null : Math.round(tGl * 100),
      verdict: (tGl !== null && tGl >= SEUIL) || (tMt !== null && tMt >= SEUIL) ? 'ok' : 'incohérent',
    };
    if (details.paire_gl_1.verdict !== 'ok') {
      echecs.push('paires GL → ' + p0.gl + ' / ' + p0.montant + ' : aucune valeur plausible');
    }
  }

  return { valide: echecs.length === 0, details, echecs };
}

// Orchestration : introspecte, mappe par position, échantillonne, valide.
// `depot` fournit listerColonnes(table) et echantillonner(table, n).
async function deduire(nomTable, depot, tailleEchantillon) {
  const n = tailleEchantillon || 300;
  const def = TABLES[nomTable];
  if (!def) return { table: nomTable, retenu: false, raison: 'table inconnue du bridge' };

  let colonnes;
  try {
    colonnes = await depot.listerColonnes(nomTable);
  } catch (e) {
    return { table: nomTable, retenu: false, raison: 'introspection impossible : ' + e.message };
  }
  if (!colonnes || !colonnes.length) {
    return { table: nomTable, retenu: false, raison: 'aucune colonne retournée par le pilote' };
  }

  const pos = mapperParPosition(nomTable, colonnes);
  if (pos.horsBornes.length) {
    return {
      table: nomTable, retenu: false, nbColonnes: pos.nbColonnes,
      raison: 'la table a moins de colonnes que l\'export : ' + pos.horsBornes.join(', ') +
        '. L\'ordre des colonnes ne correspond pas — mappage manuel requis.',
    };
  }

  let echantillon;
  try {
    echantillon = await depot.echantillonner(nomTable, n);
  } catch (e) {
    return { table: nomTable, retenu: false, nbColonnes: pos.nbColonnes,
             raison: 'échantillonnage impossible : ' + e.message };
  }
  if (!echantillon || !echantillon.length) {
    return { table: nomTable, retenu: false, nbColonnes: pos.nbColonnes,
             raison: 'la table est vide — rien à valider' };
  }

  const v = valider(nomTable, pos.mappage, pos.paires, echantillon);
  return {
    table: nomTable,
    retenu: v.valide,
    nbColonnes: pos.nbColonnes,
    nbLignesEchantillon: echantillon.length,
    mappage: pos.mappage,
    strategies: pos.strategies,
    paires: pos.paires,
    controles: v.details,
    echecs: v.echecs,
    raison: v.valide ? null : 'validation échouée : ' + v.echecs.join(' | '),
  };
}

// Applique un mappage retenu dans la configuration vivante, pour que
// src/sources/donneesAvantage.js lise désormais la base.
function appliquer(resultat) {
  if (!resultat || !resultat.retenu) return false;
  const def = TABLES[resultat.table];
  if (!def) return false;
  for (const [champ, colonne] of Object.entries(resultat.mappage)) {
    if (def.colonnes[champ]) def.colonnes[champ].bd = colonne;
  }
  if (def.pairesGl && resultat.paires) def.pairesGl.bd = resultat.paires;
  def.mappe = true;
  return true;
}

module.exports = { deduire, appliquer, mapperParPosition, valider, CONTROLES, NATURES, OBLIGATOIRES, SEUIL };
