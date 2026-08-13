// L'instantané autonome, dans un vrai navigateur.
//
// Lancer :  npm run test:instantane
//
// CE QUE CE HARNAIS PROTÈGE
// L'instantané est le livrable réellement utilisé : un seul fichier HTML, ouvert par
// double-clic, sans serveur. Son drill-down est donc ce qui doit marcher — et le drill-down
// par CHANTIER en particulier, celui qui sert à ouvrir un chantier en perte et descendre
// jusqu'à la facture pour comprendre pourquoi.
//
// Le piège déjà rencontré : les lignes de détail se construisent avec la classe `cache`,
// et un seul niveau oublié rend visibles les milliers de pièces de tous les chantiers à la
// fois. La page « fonctionne » alors, mais elle est illisible. On compte donc les lignes
// visibles à chaque étape au lieu de vérifier qu'un clic ne plante pas.
//
// Sans Playwright, le harnais se signale comme ignoré au lieu d'échouer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  try { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; } catch (e2) {}
}
if (!chromium) {
  console.log('IGNORÉ — Playwright absent. Installer avec : npm i -D playwright');
  process.exit(0);
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'instantane-'));
const aide = require('./aide-dbf');
const ecrireDbf = aide.pour(DIR);

let reussis = 0, echecs = 0;
function verifier(nom, condition, detail) {
  if (condition) { reussis++; console.log('  ok   ' + nom); }
  else { echecs++; console.log('  ÉCHEC ' + nom + (detail ? '\n         ' + detail : '')); }
}
function nettoyer() { fs.rmSync(DIR, { recursive: true, force: true }); }

// ── Jeu d'essai : deux chantiers, dont un en perte ────────────────────────────────
// 25007 : 300 000 facturés, 360 000 de coûts → perte de 60 000 (−20 %)
// 25011 : 500 000 facturés, 400 000 de coûts → marge de 100 000 (+20 %)
// Frais généraux hors projet : 40 000
function ecrireJeu() {
  const t = [];
  let seq = 0;
  const ajout = o => t.push(aide.ligneTrans(Object.assign({ seq: ++seq, date: '20260315' }, o)));
  for (let i = 0; i < 3; i++) {
    ajout({ type: 'R', compte: '31100', montant: '100000.00', projet: '0000025007', facture: 'FC-7-' + i });
  }
  for (let i = 0; i < 5; i++) {
    ajout({ type: 'R', compte: '31100', montant: '100000.00', projet: '0000025011', facture: 'FC-11-' + i });
  }
  ecrireDbf('TRANS.DBF', aide.CHAMPS_TRANS, t);

  const p = [];
  // 25007 : deux fournisseurs de sous-traitance, un de matériaux
  for (let i = 0; i < 4; i++) {
    p.push(aide.lignePybbil({
      seq: '0000010' + i, date: '2026031' + i, noFourn: 'F001', facture: 'ST-A-' + i,
      desc: 'Charpente', total: '50000.00', projet: '0000025007',
      nom: 'GROUPE JLF', gl: [['33500', '50000.00']],
    }));
  }
  p.push(aide.lignePybbil({
    seq: '00000105', date: '20260320', noFourn: 'F002', facture: 'ST-B-1',
    desc: 'Electricite', total: '100000.00', projet: '0000025007',
    nom: 'ELECTRICITE MAURICIE', gl: [['33500', '100000.00']],
  }));
  p.push(aide.lignePybbil({
    seq: '00000106', date: '20260322', noFourn: 'F003', facture: 'MAT-1',
    desc: 'Acier', total: '60000.00', projet: '0000025007',
    nom: 'ACIER ST-TITE', gl: [['33200', '60000.00']],
  }));
  // 25011 : un seul fournisseur
  p.push(aide.lignePybbil({
    seq: '00000201', date: '20260318', noFourn: 'F004', facture: 'ST-C-1',
    desc: 'Beton', total: '400000.00', projet: '0000025011',
    nom: 'BETON PROVINCIAL', gl: [['33500', '400000.00']],
  }));
  // Frais général, sans projet
  p.push(aide.lignePybbil({
    seq: '00000301', date: '20260325', noFourn: 'G001', facture: 'FG-1',
    desc: 'Telecom', total: '40000.00', projet: '',
    nom: 'TELUS', gl: [['42120', '40000.00']],
  }));
  ecrireDbf('PYBBIL.DBF', aide.champsPybbil(), p);
}

(async () => {
  ecrireJeu();

  const sortie = path.join(DIR, 'instantane.html');
  try {
    execFileSync(process.execPath, [
      path.join(__dirname, '../scripts/instantane.js'), '2026-03-01', '2026-03-31', sortie,
    ], {
      env: Object.assign({}, process.env, {
        AVANTAGE_DBF_DIR: DIR,
        AVANTAGE_EXPORT_DIR: path.join(DIR, 'aucun-export'),
        AVANTAGE_BD_ACTIVE: 'false',
      }),
      stdio: 'pipe',
    });
  } catch (e) {
    console.error('Échec de la génération : ' + (e.stderr || e.stdout || e.message).toString());
    nettoyer();
    process.exit(1);
  }

  verifier('l\'instantané est produit en un seul fichier', fs.existsSync(sortie));

  const nav = await chromium.launch();
  const page = await nav.newPage({ viewport: { width: 1300, height: 1000 } });
  const erreursJs = [];
  page.on('pageerror', e => erreursJs.push(e.message));
  await page.goto('file://' + sortie);
  await page.waitForSelector('#corps-projets tr');

  const visibles = sel => page.locator(sel + ':not(.cache)').count();

  console.log('\nMarge par chantier');

  const depart = await visibles('#corps-projets tr');
  verifier('rien n\'est déplié au départ',
    depart <= 6, depart + ' lignes visibles — le détail doit rester replié');

  const ch = page.locator('#corps-projets tr.niv-ch').filter({ hasText: '25007' }).first();
  verifier('le chantier en perte est présent', await ch.count() === 1);

  const perte = await ch.innerText();
  verifier('sa perte est affichée', /−60 000|-60 000/.test(perte.replace(/ | /g, ' ')), perte);

  console.log('\nDrill-down du chantier');

  await ch.click();
  await page.waitForTimeout(120);
  const groupes = await page.locator('#corps-projets tr.niv-groupe:not(.cache)').allInnerTexts();
  verifier('le chantier ouvre sa facturation et ses coûts',
    groupes.length >= 2 && /Facturation/.test(groupes.join(' ')) && /Coûts/.test(groupes.join(' ')),
    groupes.join(' | '));

  verifier('les pièces restent masquées à ce niveau',
    await visibles('#corps-projets tr.niv-piece') === 0,
    await visibles('#corps-projets tr.niv-piece') + ' pièces déjà visibles');

  await page.locator('#corps-projets tr.niv-groupe:not(.cache)')
    .filter({ hasText: 'Coûts du chantier' }).first().click();
  await page.waitForTimeout(100);
  const nbPostes = await visibles('#corps-projets tr.niv-poste');
  verifier('les postes du chantier apparaissent', nbPostes === 2, nbPostes + ' postes');

  await page.locator('#corps-projets tr.niv-poste:not(.cache)').first().click();
  await page.waitForTimeout(100);
  const nbFour = await visibles('#corps-projets tr.niv-four');
  verifier('les fournisseurs du poste apparaissent', nbFour === 2, nbFour + ' fournisseurs');

  const four = await page.locator('#corps-projets tr.niv-four:not(.cache)').first().innerText();
  verifier('le fournisseur est nommé', /GROUPE JLF|ELECTRICITE MAURICIE/.test(four), four);

  await page.locator('#corps-projets tr.niv-four:not(.cache)').first().click();
  await page.waitForTimeout(100);
  const nbPieces = await visibles('#corps-projets tr.niv-piece');
  verifier('les pièces du fournisseur apparaissent, et elles seules',
    nbPieces >= 1 && nbPieces <= 4, nbPieces + ' pièces');

  const piece = await page.locator('#corps-projets tr.niv-piece:not(.cache)').first().innerText();
  verifier('la pièce porte sa date, son numéro et son GL',
    /2026/.test(piece) && /ST-A|ST-B/.test(piece) && /33500/.test(piece), piece.replace(/\n/g, ' '));

  console.log('\nRéconciliation à l\'écran');

  const somme = await page.evaluate(() => {
    const lignes = [...document.querySelectorAll('#corps-projets tr.niv-four:not(.cache)')];
    const nb = s => Number(String(s).replace(/[^\d,-]/g, '').replace(',', '.').replace(/\s/g, ''));
    const poste = document.querySelector('#corps-projets tr.niv-poste:not(.cache)');
    const cellules = t => [...t.querySelectorAll('td')].map(x => x.innerText.trim());
    return {
      poste: nb(cellules(poste)[2]),
      fournisseurs: lignes.map(t => nb(cellules(t)[2])).reduce((a, b) => a + b, 0),
    };
  });
  verifier('le poste égale la somme de ses fournisseurs',
    Math.abs(somme.poste - somme.fournisseurs) <= 1,
    'poste ' + somme.poste + ' vs fournisseurs ' + somme.fournisseurs);

  console.log('\nRepli');

  await ch.click();
  await page.waitForTimeout(120);
  verifier('refermer le chantier referme toute sa descendance',
    await visibles('#corps-projets tr') === depart,
    await visibles('#corps-projets tr') + ' visibles, ' + depart + ' attendues');

  console.log('\nErreurs JavaScript');
  verifier('aucune erreur console', erreursJs.length === 0, erreursJs.join(' | '));

  await nav.close();
  nettoyer();
  console.log('\n' + reussis + ' réussis, ' + echecs + ' échecs');
  process.exit(echecs ? 1 : 0);
})().catch(e => {
  console.error('Échec du harnais : ' + e.stack);
  nettoyer();
  process.exit(1);
});
