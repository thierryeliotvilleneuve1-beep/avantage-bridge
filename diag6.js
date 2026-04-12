const XLSX = require('xlsx');
const wb = XLSX.readFile('./exports-avantage/export.xlsx');
const ws = wb.Sheets['PYBBIL'];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
const p = rows.filter(r => {
  const keys = Object.keys(r);
  const kP = keys.find(k => k.toLowerCase().includes('projet'));
  return parseInt((r[kP]||'').toString().trim(), 10) === 23020;
});
const keys = Object.keys(p[0]||{});
const kCmd = keys.find(k => k.toLowerCase().includes('no. de commande') || k.toLowerCase().includes('no de commande'));
const cmds = [...new Set(p.map(r=>(r[kCmd]||'').toString().trim()).filter(c=>c))];
console.log('Commandes uniques dans PYBBIL P23020 (', cmds.length, '):');
cmds.sort().forEach(c => console.log(c));
