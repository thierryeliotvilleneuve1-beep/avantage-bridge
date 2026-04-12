const fs = require('fs');
const { parse } = require('csv-parse/sync');
const content = fs.readFileSync('./exports-avantage/PYBBIL.csv', 'latin1');
const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true });
console.log('Colonnes PYBBIL:');
Object.keys(rows[0]).forEach((k, i) => console.log('  [' + i + ']', JSON.stringify(k)));
const p = rows.filter(r => {
  const keys = Object.keys(r);
  const kP = keys.find(k => k.toLowerCase().includes('projet'));
  return parseInt((r[kP]||'').trim(), 10) === 23020;
});
console.log('Lignes P23020 avec columns:true:', p.length);
if (p.length) {
  const keys = Object.keys(p[0]);
  const kCmd = keys.find(k => k.toLowerCase().includes('commande') || k.toLowerCase().includes('no.'));
  const kProjet = keys.find(k => k.toLowerCase().includes('projet'));
  console.log('kCmd:', kCmd);
  console.log('kProjet:', kProjet);
  console.log('Exemple cmd:', p[0][kCmd]);
}
