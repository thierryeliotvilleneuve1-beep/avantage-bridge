const fs = require('fs');
const { parse } = require('csv-parse/sync');

// COMITE — mapping commande -> activite
const comite = fs.readFileSync('./exports-avantage/COMITE.csv', 'latin1');
const comiteRows = parse(comite, { columns: false, skip_empty_lines: true, trim: true, from_line: 2 });
const map = {};
for (const r of comiteRows) {
  const cmd = (r[16] || '').trim().padStart(9, '0');
  const act = (r[17] || '').trim().replace(/\.00$/, '');
  if (cmd && cmd !== '000000000' && act && !map[cmd]) map[cmd] = act;
}
console.log('COMITE map size:', Object.keys(map).length);
const cmd06100 = Object.entries(map).filter(([k,v]) => v === '06100');
console.log('Commandes avec activite 06100:', cmd06100.map(([k]) => k));

// PYBBIL — factures P23020
const pybbil = fs.readFileSync('./exports-avantage/PYBBIL.csv', 'latin1');
const pybbilRows = parse(pybbil, { columns: true, skip_empty_lines: true, trim: true });
const p23020 = pybbilRows.filter(r => parseInt((r['Numéro de projet'] || '').trim(), 10) === 23020);
console.log('PYBBIL lignes P23020:', p23020.length);

// Chercher les commandes 06100 dans PYBBIL
const cmds06100 = cmd06100.map(([k]) => k);
const found = p23020.filter(r => {
  const cmd = (r['No. de commande'] || '').toString().trim().padStart(9, '0');
  return cmds06100.includes(cmd);
});
console.log('PYBBIL factures liées à 06100:', found.length);
found.slice(0, 3).forEach(r => console.log('  cmd:', r['No. de commande'], 'fournisseur:', r['Nom du fournisseur'], 'montant:', r['Montant total du compte']));
