const XLSX = require('xlsx');
const wb = XLSX.readFile('./exports-avantage/export.xlsx');
const wsPybbil = wb.Sheets['PYBBIL'];
const pybbil = XLSX.utils.sheet_to_json(wsPybbil, { defval: '' });
const p23020 = pybbil.filter(r => {
  const keys = Object.keys(r);
  const kProjet = keys.find(k => k.toLowerCase().includes('projet'));
  return parseInt((r[kProjet]||'').toString().trim(), 10) === 23020;
});
const keys = Object.keys(p23020[0] || {});
const kCommande = keys.find(k => k.toLowerCase().includes('no. de commande') || k.toLowerCase().includes('no de commande'));
console.log('kCommande PYBBIL:', kCommande);
const cmds06100 = ['000001411','000001425','000001477','000001543','000001565','000001599','000001614','000001618','000001689'];
const found = p23020.filter(r => cmds06100.includes((r[kCommande]||'').toString().trim()));
console.log('Factures P23020 liées à 06100:', found.length);
found.slice(0,3).forEach(r => console.log(JSON.stringify({
  commande: r[kCommande],
  fournisseur: r[keys.find(k=>k.toLowerCase()==='nom du fournisseur')],
  montant: r[keys.find(k=>k.toLowerCase().includes('montant total du compte'))]
})));
