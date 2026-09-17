const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');
const { EXPORT_DIR, XLSX_PATH } = require('../config');
const { parseActive } = require('../parsers/parseActive');

function csvPath(name) { return path.join(EXPORT_DIR, name); }

function readRows(name, opts) {
  const p = csvPath(name);
  if (!fs.existsSync(p)) return [];
  try {
    return parse(fs.readFileSync(p, 'latin1'), Object.assign({ skip_empty_lines: true, trim: true }, opts));
  } catch (e) {
    console.error('[ERROR] Lecture ' + name + ':', e.message);
    return [];
  }
}

function getKey(keys, ...fragments) {
  return keys.find(k => fragments.some(f => k.toLowerCase().includes(f.toLowerCase())));
}

// COMITE [16]=Num seq commande [17]=Code activite
function buildCommandeDivisionMap(rows) {
  const map = {};
  for (const r of rows) {
    const cmd = (r[16] || '').trim().padStart(9, '0');
    const act = (r[17] || '').trim().replace(/\.00$/, '');
    if (cmd && cmd !== '000000000' && act && !map[cmd]) map[cmd] = act;
  }
  return map;
}

// Index des lignes par numero de projet. Evite de balayer 180 000 lignes TRANS
// une fois par projet lors d'un sync multi-projets.
function indexByProjet(rows, accessor) {
  const map = new Map();
  for (const r of rows) {
    const raw = (accessor(r) == null ? '' : String(accessor(r))).trim();
    if (!raw) continue;
    const n = parseInt(raw, 10);
    const key = Number.isFinite(n) ? String(n) : raw;
    let bucket = map.get(key);
    if (!bucket) { bucket = []; map.set(key, bucket); }
    bucket.push(r);
  }
  return map;
}

// Lignes d'un projet donne, quel que soit le zero-padding du numero.
function rowsFor(index, code) {
  const n = parseInt(code, 10);
  return (Number.isFinite(n) ? index.get(String(n)) : null) || index.get(String(code).trim()) || [];
}

function readCommanSheet() {
  if (!fs.existsSync(XLSX_PATH)) return [];
  try {
    const wb = XLSX.readFile(XLSX_PATH);
    const ws = wb.Sheets['COMMAN'];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch (e) {
    console.error('[ERROR] Lecture COMMAN:', e.message);
    return [];
  }
}

// Charge une seule fois tous les exports Avantage en memoire.
// Un sync multi-projets relisait sinon les memes 6000+ lignes pour chaque projet.
function loadDataset() {
  const actMapRows = fs.existsSync(csvPath('ACTIVE.csv'))
    ? parseActive(fs.readFileSync(csvPath('ACTIVE.csv'), 'latin1'))
    : {};

  const conpreRows = readRows('CONPRE.csv', { columns: true });
  const preKeys = conpreRows.length ? Object.keys(conpreRows[0]) : [];

  const kProjet = getKey(preKeys, 'projet', 'CPCONUM');
  const conact = readRows('CONACT.csv', { columns: false, from_line: 2 });
  const trans = readRows('TRANS.csv', { columns: false, from_line: 2 });
  const pybbil = readRows('PYBBIL.csv', { columns: false, from_line: 2 });
  const comman = readCommanSheet();
  const kCommanProjet = comman.length
    ? Object.keys(comman[0]).find(k => k.toLowerCase().includes('projet'))
    : null;

  return {
    actMap: actMapRows,
    conpre: {
      rows: conpreRows,
      kProjet,
      kActivite: getKey(preKeys, 'activit', 'CPACT'),
      kMontant: getKey(preKeys, 'visionnel', 'Montant', 'CPMNT'),
    },
    conact, trans, pybbil, comman,
    commandeDivMap: buildCommandeDivisionMap(readRows('COMITE.csv', { columns: false, from_line: 2 })),
    contra: readRows('CONTRA.csv', { columns: true }),
    factma: readRows('FACTMA.csv', { columns: true }),
    index: {
      conpre: indexByProjet(conpreRows, r => r[kProjet]),
      conact: indexByProjet(conact, r => r[0]),
      trans: indexByProjet(trans, r => r[0]),
      pybbil: indexByProjet(pybbil, r => r[33]),
      comman: kCommanProjet ? indexByProjet(comman, r => r[kCommanProjet]) : new Map(),
    },
  };
}

// Compare un numero de projet Avantage (zero-padde ou non) au code demande.
function sameProjet(raw, code) {
  const num = (raw == null ? '' : String(raw)).trim();
  if (!num) return false;
  if (num === code.padStart(10, '0')) return true;
  const a = parseInt(num, 10);
  const b = parseInt(code, 10);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

module.exports = { loadDataset, sameProjet, getKey, csvPath, rowsFor, indexByProjet };
