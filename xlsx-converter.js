const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, 'exports-avantage', 'export.xlsx');
const OUTPUT_DIR = path.join(__dirname, 'exports-avantage');

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

console.log('Lecture de ' + INPUT + '...');
const wb = XLSX.readFile(INPUT);
console.log('Onglets trouvés :', wb.SheetNames.join(', '));

let count = 0;
for (const sheet of wb.SheetNames) {
  if (!MAPPING[sheet]) { console.log('- ' + sheet + ' → ignoré (pas dans le mapping)'); continue; }
  const ws = wb.Sheets[sheet];
  const csv = XLSX.utils.sheet_to_csv(ws, { FS: ',', strip: false });
  fs.writeFileSync(path.join(OUTPUT_DIR, MAPPING[sheet]), csv, 'latin1');
  const lines = csv.split('\n').length - 1;
  console.log('✓ ' + sheet + ' → ' + MAPPING[sheet] + ' (' + lines + ' lignes)');
  count++;
}
console.log(count + ' fichiers CSV créés dans ' + OUTPUT_DIR);
