const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'avantage-cache-'));
process.env.EXPORT_DIR = DIR;
const sources = require('../src/lib/sources');

function ecrireConpre(lignes) {
  fs.writeFileSync(path.join(DIR, 'CONPRE.csv'),
    ['Numero projet,Code activite,Montant previsionnel', ...lignes].join('\n'), 'latin1');
}

test('le cache renvoie le meme objet tant que le fichier ne bouge pas', () => {
  ecrireConpre(['99001,03000,1000.00']);
  sources.viderCache();
  const a = sources.loadConpre('99001');
  const b = sources.loadConpre('99001');
  assert.strictEqual(a.map['03000'], 1000);
  assert.strictEqual(b.map['03000'], 1000);
});

test('un nouvel export invalide le cache sans redemarrage', () => {
  ecrireConpre(['99001,03000,1000.00']);
  sources.viderCache();
  assert.strictEqual(sources.loadConpre('99001').map['03000'], 1000);

  // Nouvel export depose : mtime et taille changent.
  const p = path.join(DIR, 'CONPRE.csv');
  ecrireConpre(['99001,03000,2500.00', '99001,16000,700.00']);
  const futur = new Date(Date.now() + 60000);
  fs.utimesSync(p, futur, futur);

  const apres = sources.loadConpre('99001');
  assert.strictEqual(apres.map['03000'], 2500, 'la nouvelle valeur doit etre lue');
  assert.strictEqual(apres.map['16000'], 700);
});

test('le cache ne conserve pas les versions perimees', () => {
  ecrireConpre(['99001,03000,1.00']);
  sources.viderCache();
  sources.loadConpre('99001');
  for (let i = 2; i <= 6; i++) {
    const p = path.join(DIR, 'CONPRE.csv');
    ecrireConpre([`99001,03000,${i}.00`]);
    const futur = new Date(Date.now() + i * 60000);
    fs.utimesSync(p, futur, futur);
    sources.loadConpre('99001');
  }
  assert.strictEqual(sources.loadConpre('99001').map['03000'], 6);
});

test('un fichier absent reste absent et ne plante pas', () => {
  sources.viderCache();
  const r = sources.loadConfit('99001');
  assert.strictEqual(r.disponible, false);
  assert.deepStrictEqual(r.map, {});
});
