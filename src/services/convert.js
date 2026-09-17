const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { EXPORT_DIR, XLSX_PATH } = require('../config');

const MAPPING = {
  'FACTMA': 'FACTMA.csv',
  'CONTRA': 'CONTRA.csv',
  'ACTIVE': 'ACTIVE.csv',
  'CONPRE': 'CONPRE.csv',
  'CONACT': 'CONACT.csv',
  'ACHAT':  'ACHAT.csv',
  'SAISIE': 'SAISIE.csv',
  'COMITE': 'COMITE.csv',
  'TRANS':  'TRANS.csv',
  'COMMAN': 'COMMAN.csv',
  'PYBBIL': 'PYBBIL.csv',
};

function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; } }

// Vrai si un CSV attendu est plus vieux que export.xlsx (ou absent).
function csvStale() {
  const xlsxTime = mtime(XLSX_PATH);
  if (!xlsxTime) return false;
  return Object.values(MAPPING).some(f => {
    const t = mtime(path.join(EXPORT_DIR, f));
    return t === 0 ? f === 'CONTRA.csv' : t < xlsxTime;
  });
}

// Convertit export.xlsx en CSV. force=false => ne reconvertit que si necessaire.
function convertXlsx(force) {
  if (!fs.existsSync(XLSX_PATH)) {
    return { ok: false, skipped: true, reason: 'export.xlsx introuvable dans ' + EXPORT_DIR, files: [] };
  }
  if (!force && !csvStale()) {
    return { ok: true, skipped: true, reason: 'CSV deja a jour', files: [] };
  }
  const wb = XLSX.readFile(XLSX_PATH);
  const files = [];
  for (const sheet of wb.SheetNames) {
    if (!MAPPING[sheet]) continue;
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheet], { FS: ',', strip: false });
    fs.writeFileSync(path.join(EXPORT_DIR, MAPPING[sheet]), csv, 'latin1');
    files.push({ sheet, file: MAPPING[sheet], lignes: csv.split('\n').length - 1 });
  }
  return { ok: true, skipped: false, files, sheets: wb.SheetNames };
}

// Age de l'export Avantage, en heures.
function exportAgeHours() {
  const t = mtime(XLSX_PATH);
  if (!t) return null;
  return parseFloat(((Date.now() - t) / 3600000).toFixed(2));
}

module.exports = { convertXlsx, csvStale, exportAgeHours, mtime, MAPPING };
