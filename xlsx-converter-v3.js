// CLI: node xlsx-converter.js  — convertit exports-avantage/export.xlsx en CSV.
// La logique vit dans src/services/convert.js (aussi utilisee par le bridge).
require('dotenv').config();
const cfg = require('./src/config');
const { convertXlsx } = require('./src/services/convert');

console.log('Lecture de ' + cfg.XLSX_PATH + '...');
const r = convertXlsx(true);
if (!r.ok) { console.error('ERREUR: ' + r.reason); process.exit(1); }
if (r.sheets) console.log('Onglets trouves :', r.sheets.join(', '));
r.files.forEach(f => console.log('OK ' + f.sheet + ' -> ' + f.file + ' (' + f.lignes + ' lignes)'));
console.log(r.files.length + ' fichiers CSV crees dans ' + cfg.EXPORT_DIR);
