const XLSX = require('xlsx');
const wb = XLSX.readFile('./exports-avantage/export.xlsx');
const ws = wb.Sheets['COMITE'];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
const p = rows.filter(r => JSON.stringify(r).includes('23020'));
const keys = Object.keys(p[0] || {});
const kCommande = keys.find(k => k.toLowerCase().includes('quentiel de commande'));
const kActivite = keys.find(k => k.toLowerCase().includes('activit'));
const acts = {};
p.forEach(r => {
  const act = (r[kActivite]||'').toString().trim();
  acts[act] = (acts[act]||0) + 1;
});
console.log('Codes activite dans COMITE P23020:', acts);
