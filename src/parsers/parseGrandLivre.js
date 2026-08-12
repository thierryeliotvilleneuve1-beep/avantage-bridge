const { parse } = require('csv-parse/sync');
const { GL_TAXES } = require('../config/plan-comptable');

// Lecture du grand livre des charges directement dans les exports Avantage.
// Deux fichiers portent l'information :
//
//   PYBBIL.csv — factures fournisseurs, avec ventilation GL par paires
//                [0]=num séq  [1]=date  [2]=num fournisseur  [4]=num facture
//                [5]=description  [6]=montant total  [33]=num projet
//                [44]=no de commande  [48]=nom fournisseur
//                [8]/[9], [10]/[11] ... [26]/[27] = 10 paires GL / montant
//
//   TRANS.csv  — écritures : [0]=num projet  [1]=num GL  [2]=date
//                [3]=type + num journal  [4]=montant  [5]=code activité
//                type E = écriture salariale, B = transaction bancaire
//
// Une facture PYBBIL sans numéro de projet est un frais général : c'est la seule
// façon de distinguer une charge de structure d'un coût de chantier dans Avantage.

// Les exports Avantage sont des fichiers hérités : on y trouve des lignes au nombre de
// colonnes irrégulier et des guillemets mal fermés. Sans tolérance, une seule ligne
// abîmée ferait échouer l'état des résultats au complet. On relâche donc le contrôle
// de longueur et de guillemets, et on ignore les lignes vides.
function lignesCsv(contenu) {
  return parse(contenu, {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    from_line: 2,
    relax_column_count: true,
    relax_quotes: true,
  });
}

function nombre(v) {
  if (v === undefined || v === null) return 0;
  const n = parseFloat(v.toString().replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// Avantage écrit les dates en AAAA/MM/JJ ou AAAA-MM-JJ selon l'export.
function normaliserDate(v) {
  const s = (v || '').toString().trim().replace(/\//g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
}

function normaliserProjet(v) {
  const s = (v || '').toString().trim();
  if (!s) return '';
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n === 0) return '';
  return String(n).padStart(5, '0');
}

function normaliserActivite(v) {
  return (v || '').toString().trim().replace(/\.00$/, '');
}

// Éclate une ligne PYBBIL en une ligne de charge par paire GL, taxes exclues.
// Si aucune paire GL n'est exploitable, on retombe sur le montant total pour ne
// jamais perdre la charge — elle ressortira dans « À classer ».
function eclaterPybbil(r) {
  const numeroProjet = normaliserProjet(r[33]);
  const commun = {
    source: 'PYBBIL',
    numeroJournal: 'P' + (r[0] || '').toString().trim(),
    date: normaliserDate(r[1]),
    numeroFacture: (r[4] || '').toString().trim(),
    description: (r[5] || '').toString().trim(),
    fournisseur: (r[48] || '').toString().trim() || (r[2] || '').toString().trim(),
    numeroProjet,
    estProjet: numeroProjet !== '',
    numeroCommande: (r[44] || '').toString().trim(),
    typeTransaction: 'P',
  };

  const lignes = [];
  for (let i = 0; i <= 9; i++) {
    const gl = (r[8 + i * 2] || '').toString().trim();
    const montant = nombre(r[9 + i * 2]);
    if (!gl || GL_TAXES.includes(gl) || montant === 0) continue;
    lignes.push(Object.assign({}, commun, { numeroGl: gl, montant }));
  }

  if (!lignes.length) {
    const total = nombre(r[6]);
    if (total === 0) return [];
    lignes.push(Object.assign({}, commun, { numeroGl: '', montant: total }));
  }
  return lignes;
}

function parsePybbil(contenu) {
  const lignes = [];
  for (const r of lignesCsv(contenu)) {
    for (const l of eclaterPybbil(r)) lignes.push(l);
  }
  return lignes;
}

// TRANS : écritures salariales (E) et bancaires (B). Les écritures salariales
// portent la main-d'oeuvre imputée aux projets — c'est le poste que le scénario
// de réduction fait bouger le plus.
function parseTrans(contenu) {
  const lignes = [];
  for (const r of lignesCsv(contenu)) {
    const journal = (r[3] || '').toString().trim();
    const type = journal.charAt(0);
    if (type !== 'E' && type !== 'B') continue;

    const montant = nombre(r[4]);
    if (montant === 0) continue;

    const numeroProjet = normaliserProjet(r[0]);
    lignes.push({
      source: 'TRANS',
      numeroJournal: journal,
      date: normaliserDate(r[2]),
      numeroFacture: '',
      description: type === 'E' ? 'Écriture salariale' : 'Transaction bancaire',
      fournisseur: type === 'E' ? 'Masse salariale' : 'Banque',
      numeroProjet,
      estProjet: numeroProjet !== '',
      codeActivite: normaliserActivite(r[5]),
      numeroGl: (r[1] || '').toString().trim(),
      montant,
      typeTransaction: type,
      estMo: type === 'E',
    });
  }
  return lignes;
}

// COMITE : rattache un numéro de commande à un code d'activité, ce qui permet
// d'afficher la division CSI sur les factures PYBBIL.
function parseComiteDivisions(contenu) {
  const map = {};
  for (const r of lignesCsv(contenu)) {
    const cmd = (r[16] || '').toString().trim().padStart(9, '0');
    const act = normaliserActivite(r[17]);
    if (cmd && cmd !== '000000000' && act && !map[cmd]) map[cmd] = act;
  }
  return map;
}

// FACTMA : facturation client. Sert de dénominateur à tout l'état des résultats.
//
// L'export réel d'Avantage porte des en-têtes descriptifs en français
// (« Sous-total sans taxe », « Numéro de projet »…) et non des codes courts. On repère
// donc les colonnes par leur intitulé, avec repli sur les positions relevées dans
// l'export de production. Les anciens exports à codes courts (FFNOFACT…) restent
// pris en charge.
//
// Positions de repli, relevées dans l'export CRC (index 0) :
//   1 client · 17 sous-total sans taxe · 21 solde · 24 no facture
//   25 date · 26 note de crédit · 66 no projet · 67 retenue sans taxe
const FACTMA_REPLI = {
  client: 1, montant: 17, soldeOuvert: 21, numeroFacture: 24,
  date: 25, noteCredit: 26, numeroProjet: 66, retenue: 67,
};

const FACTMA_INTITULES = {
  numeroFacture: ['numero de la facture'],
  date: ['date de la facture'],
  montant: ['sous-total sans taxe'],
  soldeOuvert: ['solde de la facture'],
  noteCredit: ['note de credit'],
  numeroProjet: ['numero de projet'],
  retenue: ['montant de retenue sans taxe'],
  client: ['client facture - nom'],
};

function sansAccents(s) {
  return (s || '').toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Associe chaque champ logique à un index de colonne.
function repererColonnesFactma(enTetes) {
  const normalises = enTetes.map(sansAccents);
  const idx = {};
  for (const [champ, intitules] of Object.entries(FACTMA_INTITULES)) {
    let trouve = -1;
    for (const it of intitules) {
      trouve = normalises.findIndex(h => h === sansAccents(it));
      if (trouve === -1) trouve = normalises.findIndex(h => h.startsWith(sansAccents(it)));
      if (trouve !== -1) break;
    }
    idx[champ] = trouve !== -1 ? trouve : FACTMA_REPLI[champ];
  }
  return idx;
}

function parseFactmaRevenus(contenu) {
  const toutes = parse(contenu, {
    columns: false, skip_empty_lines: true, trim: true,
    relax_column_count: true, relax_quotes: true,
  });
  if (!toutes.length) return [];

  const enTetes = toutes[0].map(x => (x || '').toString());

  // Ancien format à codes courts : on le reconnaît à la présence de FFNOFACT.
  const ancien = enTetes.some(h => /^FFNOFACT$/i.test(h.trim()));
  if (ancien) {
    const records = parse(contenu, {
      columns: true, skip_empty_lines: true, trim: true,
      relax_column_count: true, relax_quotes: true,
    });
    return records.map(r => ({
      numeroFacture: (r.FFNOFACT || '').trim(),
      numeroProjet: normaliserProjet(r.FFCONT),
      client: (r.FFVENTE || r.FFNOM || '').trim(),
      date: normaliserDate(r.FFDATE),
      montant: nombre(r.FFTOTDU),
      soldeOuvert: nombre(r.FFSOLDE),
      retenue: nombre(r.FFMNTRET),
      noteCredit: false,
    })).filter(f => f.numeroFacture);
  }

  const c = repererColonnesFactma(enTetes);
  const sorties = [];
  for (let i = 1; i < toutes.length; i++) {
    const r = toutes[i];
    const numeroFacture = (r[c.numeroFacture] || '').toString().trim();
    if (!numeroFacture) continue;
    const date = normaliserDate(r[c.date]);
    if (!date) continue;

    // Une note de crédit vient en diminution du revenu.
    const noteCredit = /^(true|t|o|oui|vrai|1)$/i.test((r[c.noteCredit] || '').toString().trim());
    const signe = noteCredit ? -1 : 1;

    sorties.push({
      numeroFacture,
      numeroProjet: normaliserProjet(r[c.numeroProjet]),
      client: (r[c.client] || '').toString().trim(),
      date,
      montant: signe * nombre(r[c.montant]),
      soldeOuvert: signe * nombre(r[c.soldeOuvert]),
      retenue: signe * nombre(r[c.retenue]),
      noteCredit,
    });
  }
  return sorties;
}

module.exports = {
  parsePybbil, parseTrans, parseComiteDivisions, parseFactmaRevenus,
  normaliserDate, normaliserProjet, normaliserActivite, nombre,
};
