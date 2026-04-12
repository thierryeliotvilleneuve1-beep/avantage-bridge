const XLSX = require('xlsx');
const wb = XLSX.readFile('./exports-avantage/export.xlsx');
const ws = wb.Sheets['COMITE'];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
const p23020 = rows.filter(r => String(r['Numéro de projet']||'').includes('23020'));
console.log('Lignes P23020:', p23020.length);
console.log('Activités:', [...new Set(p23020.map(r => r["Code d'activité"]))].join(', '));
const ex = p23020.filter(r => r["Code d'activité"] === '25100').slice(0,2);
console.log('Ex 25100:', JSON.stringify(ex, null, 2));
