// Source « export Excel » — lit les CSV produits par xlsx-converter et les
// normalise dans les formes canoniques consommees par les services de sync.
// Les index de colonnes sont ceux valides contre les donnees reelles d'Avantage.
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { EXPORT_DIR } = require('../config');
const { convertXlsx, exportAgeHours } = require('../services/convert');

function readRows(name, opts) {
  const p = path.join(EXPORT_DIR, name);
  if (!fs.existsSync(p)) return [];
  try {
    return parse(fs.readFileSync(p, 'latin1'), Object.assign({ skip_empty_lines: true, trim: true }, opts));
  } catch (e) {
    console.error('[ERROR] Lecture ' + name + ':', e.message);
    return [];
  }
}

const txt = v => (v == null ? '' : String(v)).trim();
const act = v => txt(v).replace(/\.00$/, '');
const num = v => parseFloat(txt(v).replace(',', '.')) || 0;
const dat = v => txt(v).replace(/\//g, '-');

function getKey(keys, ...fragments) {
  return keys.find(k => fragments.some(f => k.toLowerCase().includes(f.toLowerCase())));
}

// Projets et factures client — toujours lus en entier.
function loadProjets() {
  const projets = readRows('CONTRA.csv', { columns: true }).map(r => ({
    numero: txt(r.CONUM), nom: txt(r.CONOM || r.CONOMS), client: txt(r.COCLINOM || r.COCLI),
    statut: txt(r.COSTT), date_debut: txt(r.COFADATER), date_fin_prevue: txt(r.COFADATEP),
    solde: num(r.COSOLDER), profit: num(r.COPRCPROF),
  }));

  const facturesClient = readRows('FACTMA.csv', { columns: true }).map(r => ({
    numero_facture: txt(r.FFNOFACT), projet: txt(r.FFCONT), client: txt(r.FFVENTE || r.FFNOM),
    date: txt(r.FFDATE), date_echeance: txt(r.FFDATEP), total: num(r.FFTOTDU),
    solde: num(r.FFSOLDE), retenue: num(r.FFMNTRET),
  }));

  return { source: 'xlsx', projets, facturesClient };
}

// Detail budgetaire — filtre en memoire sur les projets demandes.
function loadDetail(codes) {
  const garder = codeFilter(codes);

  // ACTIVE — [0]=code [1]=description francaise
  const activites = readRows('ACTIVE.csv', { columns: false, from_line: 2 })
    .map(r => ({ code: act(r[0]), nom: txt(r[1]) || act(r[0]) }))
    .filter(x => x.code);

  // CONPRE — colonnes nommees, libelles variables selon l'export
  const preRows = readRows('CONPRE.csv', { columns: true });
  const preKeys = preRows.length ? Object.keys(preRows[0]) : [];
  const kP = getKey(preKeys, 'projet', 'CPCONUM');
  const kA = getKey(preKeys, 'activit', 'CPACT');
  const kM = getKey(preKeys, 'visionnel', 'Montant', 'CPMNT');
  const budget = preRows.map(r => ({ projet: txt(r[kP]), activite: act(r[kA]), montant: num(r[kM]) }))
    .filter(x => garder(x.projet));

  // CONACT — [0]=projet [1]=activite [3]=depense a venir [4]=facture a date
  const facturationActivite = readRows('CONACT.csv', { columns: false, from_line: 2 })
    .map(r => ({ projet: txt(r[0]), activite: act(r[1]), depense_a_venir: num(r[3]), facture: num(r[4]) }))
    .filter(x => garder(x.projet));

  // TRANS — [0]=projet [1]=GL [2]=date [3]=journal [4]=montant [5]=activite
  const transactions = readRows('TRANS.csv', { columns: false, from_line: 2 })
    .map(r => ({ projet: txt(r[0]), gl: txt(r[1]), date: dat(r[2]), journal: txt(r[3]), montant: num(r[4]), activite: act(r[5]) }))
    .filter(x => garder(x.projet));

  // PYBBIL — [0]=seq [1]=date [4]=no facture [5]=description [6]=montant total
  // [8..27]=paires GL/montant [33]=projet [44]=no commande [48]=fournisseur
  const facturesFournisseur = readRows('PYBBIL.csv', { columns: false, from_line: 2 }).map(r => {
    const ventilation = [];
    for (let i = 0; i <= 9; i++) {
      const gl = txt(r[8 + i * 2]);
      if (gl) ventilation.push({ gl, montant: parseFloat(r[9 + i * 2]) || 0 });
    }
    return {
      seq: txt(r[0]), date: dat(r[1]), no_facture: txt(r[4]), description: txt(r[5]),
      montant_total: parseFloat(r[6]) || 0, projet: txt(r[33]), no_commande: txt(r[44]),
      fournisseur: txt(r[48]), ventilation,
    };
  }).filter(x => garder(x.projet));

  // COMITE — [16]=sequentiel de commande [17]=activite
  const commandeItems = readRows('COMITE.csv', { columns: false, from_line: 2 })
    .map(r => ({ no_commande: txt(r[16]), activite: act(r[17]) }));

  // COMMAN — entetes de BC, lues dans le classeur avec leurs libelles francais
  const commandes = readComman().filter(x => garder(x.projet));

  return {
    source: 'xlsx',
    lu_a: new Date().toISOString(),
    age_heures: exportAgeHours(),
    activites, budget, facturationActivite, transactions,
    facturesFournisseur, commandeItems, commandes,
  };
}

const XLSX = require('xlsx');
function readComman() {
  const xlsxPath = path.join(EXPORT_DIR, 'export.xlsx');
  if (!fs.existsSync(xlsxPath)) return [];
  try {
    const wb = XLSX.readFile(xlsxPath);
    const ws = wb.Sheets['COMMAN'];
    if (!ws) return [];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) return [];
    const keys = Object.keys(rows[0]);
    const kProjet = getKey(keys, 'projet');
    const kSeq = keys.find(k => k.includes('quentiel') && !k.includes('commande'));
    const kSeqCommande = keys.find(k => k.includes('quentiel') && k.includes('commande'));
    const kFournisseur = keys.find(k => k.includes('fournisseur') && k.toLowerCase().includes('num'));
    const kNomFournisseur = keys.find(k => k.toLowerCase() === 'nom du fournisseur');
    const kMontant = keys.find(k => k.toLowerCase().includes('sous-total'));
    const kStatut = keys.find(k => k.toLowerCase().includes('statut'));
    return rows.map(r => ({
      projet: txt(r[kProjet]), seq: txt(r[kSeq]), seq_commande: txt(r[kSeqCommande]),
      no_fournisseur: txt(r[kFournisseur]), nom_fournisseur: txt(r[kNomFournisseur]) || txt(r[kFournisseur]),
      sous_total: parseFloat(r[kMontant]) || 0, statut: txt(r[kStatut]),
    }));
  } catch (e) {
    console.error('[ERROR] Lecture COMMAN:', e.message);
    return [];
  }
}

// Le sync appelle prepare() avant load(): ici, regenerer les CSV si besoin.
function prepare(force) { return convertXlsx(force === true); }

// Un code projet peut etre zero-padde d'un cote et pas de l'autre.
function codeFilter(codes) {
  if (!codes || !codes.length) return () => true;
  const set = new Set();
  for (const c of codes) {
    const t = String(c).replace(/^P/i, '').trim();
    set.add(t);
    const n = parseInt(t, 10);
    if (Number.isFinite(n)) set.add(String(n));
  }
  return raw => {
    const t = String(raw == null ? '' : raw).trim();
    if (set.has(t)) return true;
    const n = parseInt(t, 10);
    return Number.isFinite(n) && set.has(String(n));
  };
}

module.exports = { loadProjets, loadDetail, prepare, getKey };
