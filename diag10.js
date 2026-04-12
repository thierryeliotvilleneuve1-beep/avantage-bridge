const XLSX = require('xlsx');
const wb = XLSX.readFile('./exports-avantage/export.xlsx');
const ws = wb.Sheets['PYBACM'];
if (!ws) { console.log('PYBACM absent'); process.exit(); }
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
console.log('Colonnes:', Object.keys(rows[0]));
const p = rows.filter(r => JSON.stringify(r).includes('23020'));
console.log('Lignes P23020:', p.length);
p.slice(0,2).forEach(r => console.log(JSON.stringify(r)));
