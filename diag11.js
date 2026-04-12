const fs = require('fs');
const { parse } = require('csv-parse/sync');

const content = fs.readFileSync('./exports-avantage/PYBBIL.csv', 'latin1');
const rows = parse(content, { columns: false, skip_empty_lines: true, trim: true, from_line: 2 });

// P23020
const p = rows.filter(r => parseInt((r[33]||'').trim(), 10) === 23020);
console.log('Lignes P23020:', p.length);

// Analyser les GL utilisés
const glUsed = {};
for (const r of p) {
  for (let i = 0; i <= 9; i++) {
    const gl = (r[8 + i*2] || '').trim();
    const mt = parseFloat(r[9 + i*2]) || 0;
    if (gl && mt !== 0) {
      if (!glUsed[gl]) glUsed[gl] = { count: 0, total: 0 };
      glUsed[gl].count++;
      glUsed[gl].total += mt;
    }
  }
}
console.log('GL utilisés dans PYBBIL P23020:');
Object.entries(glUsed).sort((a,b) => b[1].total - a[1].total)
  .forEach(([gl, v]) => console.log('  GL', gl, '— count:', v.count, '— total:', v.total.toFixed(2)));

// Vérifier PRO ARMATURE facture 060449 (montant net attendu 37819.50)
const ex = p.filter(r => (r[0]||'').trim() === '060449');
if (ex.length) {
  console.log('\nFacture 060449:');
  console.log('  Total compte:', r[6]);
  for (let i = 0; i <= 9; i++) {
    const gl = (ex[0][8 + i*2] || '').trim();
    const mt = parseFloat(ex[0][9 + i*2]) || 0;
    if (gl) console.log('  GL', gl, '=', mt);
  }
}
