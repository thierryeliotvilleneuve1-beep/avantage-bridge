// Les revenus lus dans le grand livre, quand la table de facturation est chiffrée.
//
// Lancer :  npm run test:grand-livre
//
// CE QUE CE HARNAIS PROTÈGE
// Sur l'installation réelle de CRC, Avantage chiffre FACTMA et CONTRA : les noms de champs
// restent lisibles, le contenu non. Les revenus doivent donc venir du grand livre TRANS,
// aux comptes de produits 31xxx. Mais TRANS contient aussi :
//
//   P — la contrepartie des factures fournisseurs, que PYBBIL porte déjà
//   C — les engagements de contrat, qui ne sont pas des dépenses
//   R — le journal des produits, qui appartient aux revenus
//
// Additionner ces journaux aux charges gonflerait les coûts sans qu'aucun message ne le
// signale. Le jeu d'essai ci-dessous les met tous en présence, avec des montants choisis
// pour qu'un doublon ou un oubli change le résultat net de façon visible.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dbf-gl-'));
process.env.AVANTAGE_DBF_DIR = DIR;
process.env.AVANTAGE_EXPORT_DIR = path.join(DIR, 'aucun-export');

const aide = require('./aide-dbf');
const ecrireDbf = aide.pour(DIR);

let reussis = 0, echecs = 0;
async function test(nom, fn) {
  try { await fn(); reussis++; console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.log('  ÉCHEC ' + nom + '\n         ' + e.message); }
}

// ── Le jeu d'essai ───────────────────────────────────────────────────────────────
// Revenus     1 000 000  (journal R, compte 31100, 10 écritures)
// Doublon       250 000  (journal P, compte 33500 — les mêmes factures que PYBBIL)
// Engagement    900 000  (journal C, compte 33500 — octroi de sous-traitance)
// Salaires       80 000  (journal E, compte 43100 — structure)
// PYBBIL        250 000  de sous-traitance sur projet + 60 000 de télécom hors projet
//
// Attendu : revenus 1 000 000, charges 390 000, résultat net 610 000.
// Si le journal P était compté, les charges passeraient à 640 000 et le résultat à 360 000.
// Si le journal C l'était aussi, le résultat tomberait à -540 000.
const REVENUS_ATTENDUS = 1000000;
const CHARGES_ATTENDUES = 390000;
const RESULTAT_ATTENDU = 610000;

function ecrireJeu() {
  const t = [];
  let seq = 0;
  const ajout = o => t.push(aide.ligneTrans(Object.assign({ seq: ++seq, date: '20260315' }, o)));

  for (let i = 0; i < 10; i++) {
    ajout({ type: 'R', compte: '31100', montant: '100000.00', projet: '0000025007', facture: 'FC-' + i });
  }
  for (let i = 0; i < 5; i++) {
    ajout({ type: 'P', compte: '33500', montant: '50000.00', projet: '0000025007', facture: 'ST-' + i });
  }
  for (let i = 0; i < 3; i++) {
    ajout({ type: 'C', compte: '33500', montant: '300000.00', projet: '0000025007' });
  }
  for (let i = 0; i < 4; i++) {
    ajout({ type: 'E', compte: '43100', montant: '20000.00', projet: '0000025007' });
  }
  ecrireDbf('TRANS.DBF', aide.CHAMPS_TRANS, t);

  const p = [];
  for (let i = 0; i < 5; i++) {
    p.push(aide.lignePybbil({
      seq: '0000010' + i, date: '20260315', noFourn: 'F00' + i, facture: 'ST-' + i,
      desc: 'Sous-traitance', total: '50000.00', projet: '0000025007',
      nom: 'GROUPE JLF', gl: [['33500', '50000.00']],
    }));
  }
  for (let i = 0; i < 3; i++) {
    p.push(aide.lignePybbil({
      seq: '0000020' + i, date: '20260320', noFourn: 'G00' + i, facture: 'FG-' + i,
      desc: 'Telecom', total: '20000.00', projet: '',
      nom: 'TELUS', gl: [['42120', '20000.00']],
    }));
  }
  ecrireDbf('PYBBIL.DBF', aide.champsPybbil(), p);

  // FACTMA chiffrée : des octets quelconques dans des champs déclarés date et nombre,
  // et le champ CRYPTED que porte la vraie table.
  const f = [];
  for (let k = 0; k < 30; k++) {
    f.push({
      FFNOFACT: Buffer.from(Array.from({ length: 10 }, (_, i) => 190 + (i * 7 + k * 3) % 60)),
      FFDATE: Buffer.from(Array.from({ length: 8 }, (_, i) => 200 + (i + k) % 50)),
      FFTOTDU: Buffer.from(Array.from({ length: 14 }, (_, i) => 195 + (i * 5 + k) % 55)),
      CRYPTED: Buffer.from([1, 2, 250, 199, 88, 17, 240, 63]),
    });
  }
  ecrireDbf('FACTMA.DBF', [
    { nom: 'FFNOFACT', type: 'C', longueur: 10 },
    { nom: 'FFDATE', type: 'D', longueur: 8 },
    { nom: 'FFTOTDU', type: 'N', longueur: 14, decimales: 2 },
    { nom: 'CRYPTED', type: 'C', longueur: 8 },
  ], f, { version: 0x06 });
}

(async () => {
  ecrireJeu();
  const etatResultats = require('../src/services/etatResultats');
  const source = require('../src/sources/donneesAvantage');
  const dbf = require('../src/db/lecteurDbf');
  const depot = require('../src/sources/depotDbf');

  console.log('\nDétection du chiffrement');

  await test('FACTMA est déclarée illisible', () => {
    const l = depot.lisibilite('FACTMA');
    assert.strictEqual(l.verdict, 'illisible', JSON.stringify(l));
  });

  await test('TRANS et PYBBIL restent lisibles', () => {
    assert.strictEqual(depot.lisibilite('TRANS').verdict, 'lisible');
    assert.strictEqual(depot.lisibilite('PYBBIL').verdict, 'lisible');
  });

  await test('le mappage de FACTMA est refusé en nommant le chiffrement', async () => {
    const res = await source.autoMapper(true);
    const factma = res.find(r => r.table === 'FACTMA');
    assert.strictEqual(factma.retenu, false);
    assert.ok(/illisible/.test(factma.raison), factma.raison);
  });

  console.log('\nLes revenus viennent du grand livre');
  const etat = await etatResultats.construire('2026-03-01', '2026-03-31');

  await test('revenus lus aux comptes de produits', () => {
    assert.strictEqual(Math.round(etat.totaux.revenus), REVENUS_ATTENDUS);
  });

  await test('la provenance nomme le grand livre, pas FACTMA', () => {
    assert.strictEqual(etat.provenance.revenus.mode, 'dbf');
    assert.ok(/grand livre/i.test(etat.provenance.revenus.detail), etat.provenance.revenus.detail);
  });

  console.log('\nAucun journal compté deux fois');

  await test('le journal P n\'est pas additionné à PYBBIL', () => {
    const total = etat.totaux.cout_direct + etat.totaux.frais_generaux + etat.totaux.non_classe;
    assert.strictEqual(Math.round(total), CHARGES_ATTENDUES,
      'charges de ' + Math.round(total) + ' $ : le journal P a probablement été compté en double');
  });

  await test('le journal C des engagements est exclu', () => {
    assert.strictEqual(Math.round(etat.totaux.resultat_net), RESULTAT_ATTENDU);
  });

  await test('les journaux écartés sont annoncés, avec leur montant', () => {
    const d = etat.provenance.ecritures.detail;
    assert.ok(/journal P/.test(d), d);
    assert.ok(/journal C/.test(d), d);
    assert.ok(/250 000/.test(d.replace(/ | /g, ' ')), d);
    assert.ok(/900 000/.test(d.replace(/ | /g, ' ')), d);
  });

  await test('le compte de produits ne se retrouve pas dans les charges', () => {
    const tous = [];
    etat.sections.forEach(s => (s.postes || []).forEach(p =>
      (p.comptes || []).forEach(c => tous.push(c.gl))));
    assert.ok(!tous.includes('31100'),
      'le compte 31100 apparaît dans les charges : il viendrait en diminution des coûts');
  });

  console.log('\nRéconciliation');

  await test('marge brute = revenus - coût direct', () => {
    assert.strictEqual(
      Math.round(etat.totaux.marge_brute),
      Math.round(etat.totaux.revenus - etat.totaux.cout_direct));
  });

  await test('la sous-traitance vient de PYBBIL, avec son fournisseur', () => {
    const st = etat.sections
      .flatMap(s => s.postes || [])
      .find(p => p.id === 'sous_traitance');
    assert.ok(st, 'poste de sous-traitance absent');
    assert.strictEqual(Math.round(st.total), 250000);
    const fournisseurs = (st.comptes || []).flatMap(c => c.fournisseurs || []).map(f => f.nom);
    assert.ok(fournisseurs.includes('GROUPE JLF'), fournisseurs.join(', '));
  });

  await test('les frais généraux viennent des factures sans projet', () => {
    const tel = etat.sections
      .flatMap(s => s.postes || [])
      .find(p => p.id === 'telecom_info');
    assert.ok(tel, 'poste télécom absent');
    assert.strictEqual(Math.round(tel.total), 60000);
  });

  await test('rien n\'est tombé dans « À classer »', () => {
    assert.strictEqual(Math.round(etat.totaux.non_classe), 0,
      'des charges non classées : ' + etat.totaux.non_classe);
  });

  console.log('\n' + reussis + ' réussis, ' + echecs + ' échecs');
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(echecs ? 1 : 0);
})().catch(e => {
  console.error('Échec du harnais : ' + e.stack);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
});
