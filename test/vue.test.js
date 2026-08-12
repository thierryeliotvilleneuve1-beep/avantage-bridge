// Contrôle de la vue interactive : drill-down, simulateur de réduction, export.
//
// Lancer :  npm run test:vue
//
// Ce test démarre le bridge sur un port libre avec un jeu de données de contrôle, puis
// pilote la page dans un vrai navigateur. Il a besoin de Playwright ; s'il est absent, le
// test se signale comme ignoré au lieu d'échouer — le harnais de base (npm test) suffit
// à valider la logique de calcul.
//
// Les montants attendus sont TOUJOURS déduits de ce que la page affiche, jamais codés en
// dur : le test reste valide quel que soit le jeu de données.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

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

const CLE = 'test-vue';
let reussis = 0, echecs = 0;
function verifier(nom, condition, detail) {
  if (condition) { reussis++; console.log('  ok   ' + nom); }
  else { echecs++; console.log('  ÉCHEC ' + nom + (detail ? '\n         ' + detail : '')); }
}

// Un montant affiché « 1 234 $ » redevient 1234. Le séparateur de milliers est une
// espace insécable. Certains libellés en contiennent deux (période puis annualisé) :
// on ne prend que le PREMIER, sinon les deux nombres se retrouvent collés.
function montant(txt) {
  const s = String(txt || '');
  const jeton = s.match(/-?[\d][\d\s  ]*(?:[.,]\d+)?\s*\$/);
  if (!jeton) return null;
  const brut = jeton[0].replace(/\$/, '').replace(/[\s  ]/g, '').replace(',', '.');
  const n = parseFloat(brut);
  return Number.isFinite(n) ? n : null;
}

function portLibre() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

function ecrireFixtures(dir) {
  const ligne = o => {
    const c = new Array(49).fill('');
    c[0] = o.seq; c[1] = o.date; c[4] = o.fact; c[5] = o.desc;
    c[6] = o.total; c[33] = o.proj || ''; c[48] = o.nom;
    (o.v || []).forEach(([g, m], i) => { c[8 + i * 2] = g; c[9 + i * 2] = m; });
    return c.join(',');
  };
  const pybbil = ['en-tete',
    ligne({ seq: 1, date: '2026-02-10', fact: 'ST-1', desc: 'Charpente', total: 120000, proj: '25007', nom: 'GROUPE JLF CONSTRUCTION INC.', v: [['33500', 120000]] }),
    ligne({ seq: 2, date: '2026-03-11', fact: 'ST-2', desc: 'Toiture', total: 64000, proj: '25007', nom: 'WALKER CONSTRUCTION', v: [['33500', 64000]] }),
    ligne({ seq: 3, date: '2026-03-15', fact: 'MT-1', desc: 'Acier', total: 22000, proj: '26004', nom: 'BOULAY INOX INC.', v: [['33200', 22000]] }),
    ligne({ seq: 4, date: '2026-01-20', fact: 'FG-1', desc: 'Informatique', total: 18000, nom: 'BLACKWARE TECHNOLOGIES INC.', v: [['42120', 18000]] }),
    ligne({ seq: 5, date: '2026-02-18', fact: 'FG-2', desc: 'Cellulaires', total: 6200, nom: 'TELUS MOBILITE', v: [['42120', 6200]] }),
    ligne({ seq: 6, date: '2026-04-05', fact: 'FG-3', desc: 'Honoraires', total: 9400, nom: 'MALLETTE S.E.N.C.R.L.', v: [['42101', 9400]] }),
    ligne({ seq: 7, date: '2026-04-22', fact: 'FG-4', desc: 'Carburant', total: 7300, nom: 'HARNOIS ENERGIES INC.', v: [['42125', 7300]] }),
  ].join('\n');

  const trans = ['en-tete',
    '25007,34100,2026-03-01,E001,88000,06100',
    '26004,34100,2026-04-01,E002,31000,00400',
    ',43100,2026-02-01,E003,145000,',
  ].join('\n');

  const factma = ['FFNOFACT,FFCONT,FFVENTE,FFDATE,FFTOTDU,FFSOLDE,FFMNTRET',
    'F-1,25007,CONSEIL DE LA NATION ATIKAMEKW,2026-03-31,410000,0,20500',
    'F-2,26004,CARPE DIEM,2026-04-30,185000,185000,9250',
  ].join('\n');

  fs.writeFileSync(path.join(dir, 'PYBBIL.csv'), pybbil, 'latin1');
  fs.writeFileSync(path.join(dir, 'TRANS.csv'), trans, 'latin1');
  fs.writeFileSync(path.join(dir, 'FACTMA.csv'), factma, 'latin1');
  fs.writeFileSync(path.join(dir, 'CONTRA.csv'),
    ['CONUM,CONOM,COCLINOM,COSTT',
     '25007,TV-18 Atikamekw,CONSEIL DE LA NATION ATIKAMEKW,A',
     '26004,BD-50 Eglise,CARPE DIEM,A'].join('\n'), 'latin1');
  fs.writeFileSync(path.join(dir, 'ACTIVE.csv'), ['en-tete', '06100,Charpenterie,x', '00400,Conditions generales,x'].join('\n'), 'latin1');
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avantage-vue-'));
  ecrireFixtures(dir);
  const port = await portLibre();

  const serveur = spawn(process.execPath, [path.join(__dirname, '../src/index.js')], {
    env: Object.assign({}, process.env, {
      AVANTAGE_EXPORT_DIR: dir, API_KEY: CLE, PORT: String(port),
      AVANTAGE_BD_ACTIVE: 'false', CRON_SCHEDULE: '0 0 31 2 *',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const nettoyer = () => {
    try { serveur.kill('SIGKILL'); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
  };

  // Attendre que le bridge réponde.
  const base = 'http://127.0.0.1:' + port;
  let pret = false;
  for (let i = 0; i < 50 && !pret; i++) {
    await new Promise(r => setTimeout(r, 200));
    try { const r = await fetch(base + '/api/status'); pret = r.ok; } catch (e) {}
  }
  if (!pret) { console.log('ÉCHEC — le bridge n\'a pas démarré sur le port ' + port); nettoyer(); process.exit(1); }

  const nav = await chromium.launch(
    fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
      ? { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] }
      : { args: ['--no-sandbox'] }
  );
  const page = await nav.newPage({ viewport: { width: 1300, height: 1000 } });
  const erreursJs = [];
  page.on('pageerror', e => erreursJs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') erreursJs.push(m.text()); });

  await page.goto(base + '/api/etat-resultats/vue?key=' + CLE, { waitUntil: 'networkidle' });
  await page.fill('#debut', '2026-01-01');
  await page.fill('#fin', '2026-12-31');
  await page.click('#btnCharger');
  await page.waitForFunction(() => document.querySelector('table.pl tbody tr'), { timeout: 15000 });

  const visibles = () => page.evaluate(() =>
    [...document.querySelectorAll('table.pl tbody tr')].filter(t => !t.classList.contains('cache')).length);

  console.log('\nIntégrité de l\'arbre');
  const arbre = await page.evaluate(() => {
    const cles = new Set([...document.querySelectorAll('[data-cle]')].map(e => e.getAttribute('data-cle')));
    const parents = [...document.querySelectorAll('[data-parent]')].map(e => e.getAttribute('data-parent'));
    return { orphelins: [...new Set(parents.filter(p => !cles.has(p)))], nbCles: cles.size, nbEnfants: parents.length };
  });
  verifier('aucun parent orphelin', arbre.orphelins.length === 0, 'orphelins : ' + arbre.orphelins.join(', '));
  verifier('arbre peuplé', arbre.nbCles > 5 && arbre.nbEnfants > 10, arbre.nbCles + ' clés / ' + arbre.nbEnfants + ' enfants');

  console.log('\nDrill-down sur quatre niveaux');
  const n0 = await visibles();
  await page.evaluate(() => {
    const tr = [...document.querySelectorAll('tr.n1')].find(t => t.textContent.includes('Sous-traitance'));
    tr.click();
  });
  await page.waitForTimeout(120);
  const n1 = await visibles();
  verifier('un poste ouvre ses comptes GL', n1 > n0, n0 + ' -> ' + n1);

  await page.evaluate(() => [...document.querySelectorAll('tr.n2')].filter(t => !t.classList.contains('cache'))[0].click());
  await page.waitForTimeout(120);
  const n2 = await visibles();
  verifier('un compte GL ouvre ses fournisseurs', n2 > n1, n1 + ' -> ' + n2);

  await page.evaluate(() => [...document.querySelectorAll('tr.n3')].filter(t => !t.classList.contains('cache'))[0].click());
  await page.waitForTimeout(120);
  const n3 = await visibles();
  verifier('un fournisseur ouvre ses factures', n3 > n2, n2 + ' -> ' + n3);

  const detail = await page.evaluate(() => {
    const t = [...document.querySelectorAll('tr.n4')].filter(x => !x.classList.contains('cache'))[0];
    return t ? t.textContent.trim() : null;
  });
  verifier('la facture porte une date et un numéro',
    Boolean(detail) && /\d{4}-\d{2}-\d{2}/.test(detail) && /no /.test(detail), 'ligne : ' + detail);

  console.log('\nRéconciliation affichée : un poste égale la somme de ses comptes');
  const reconc = await page.evaluate(() => {
    const lignes = [...document.querySelectorAll('table.pl tbody tr')];
    const val = tr => {
      const t = tr.children[1] ? tr.children[1].textContent : '';
      const n = parseFloat(t.replace(/[^\d,.-]/g, '').replace(/\s/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    };
    const poste = lignes.find(t => t.classList.contains('n1') && t.getAttribute('data-cle'));
    if (!poste) return null;
    const cle = poste.getAttribute('data-cle');
    const enfants = lignes.filter(t => t.getAttribute('data-parent') === cle);
    return { total: val(poste), somme: enfants.reduce((a, t) => a + (val(t) || 0), 0), n: enfants.length };
  });
  verifier('poste = somme de ses comptes GL',
    reconc && reconc.n > 0 && Math.abs(reconc.total - reconc.somme) < 1,
    reconc ? reconc.total + ' vs ' + reconc.somme + ' (' + reconc.n + ' comptes)' : 'non mesurable');

  console.log('\nRepliage');
  await page.evaluate(() => {
    const tr = [...document.querySelectorAll('tr.n1')].find(t => t.textContent.includes('Sous-traitance'));
    tr.click();
  });
  await page.waitForTimeout(120);
  verifier('replier referme toute la descendance', (await visibles()) === n0, 'attendu ' + n0);

  console.log('\nSimulateur de réduction');
  verifier('économie nulle au départ',
    (await page.evaluate(() => document.querySelector('#simEco').textContent.trim())) === '—');

  // On choisit le premier poste simulable et on déduit l'attendu de ce qui est affiché.
  const sim = await page.evaluate(async () => {
    const inp = document.querySelector('input.red');
    const poste = inp.getAttribute('data-poste');
    const tr = inp.closest('tr');
    const brut = tr.children[1].textContent;
    inp.value = '20';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 80));
    return {
      poste, brut,
      apres: document.querySelector('[data-apres="' + poste + '"]').textContent,
      eco: document.querySelector('[data-eco="' + poste + '"]').textContent,
      ecoTotal: document.querySelector('#simEco').textContent,
      resultat: document.querySelector('#simResultat').textContent,
      seuil: document.querySelector('#simSeuil').textContent,
    };
  });
  const brut = montant(sim.brut);
  verifier('économie de la ligne = 20 % du montant',
    Math.abs(montant(sim.eco) - brut * 0.20) <= 1, sim.eco + ' pour un brut de ' + sim.brut);
  verifier('montant après réduction = 80 % du montant',
    Math.abs(montant(sim.apres) - brut * 0.80) <= 1, sim.apres);
  verifier('économie totale reprend la ligne',
    Math.abs(montant(sim.ecoTotal) - brut * 0.20) <= 1, sim.ecoTotal);
  verifier('résultat net simulé affiché', /simulé/.test(sim.resultat), sim.resultat);
  verifier('seuil de rentabilité simulé affiché', /simulé/.test(sim.seuil), sim.seuil);

  // Le seuil simulé doit baisser : on coupe des frais fixes.
  const seuils = await page.evaluate(() => {
    const kpis = [...document.querySelectorAll('.kpi')];
    const k = kpis.find(x => x.textContent.includes('Seuil de rentabilité'));
    return { texte: k.textContent };
  });
  const nums = seuils.texte.match(/[\d\s  ]+\$/g) || [];
  verifier('le seuil simulé est inférieur au seuil courant',
    nums.length >= 2 && montant(nums[1]) < montant(nums[0]),
    seuils.texte.replace(/\s+/g, ' '));

  console.log('\nCumul et remise à zéro');
  const cumul = await page.evaluate(async () => {
    const inps = [...document.querySelectorAll('input.red')];
    const a = inps[0], b = inps[1];
    const brutA = montantOf(a), brutB = montantOf(b);
    function montantOf(i){ const t=i.closest('tr').children[1].textContent;
      return parseFloat(t.replace(/[^\d,.-]/g,'').replace(/\s/g,'').replace(',','.')); }
    b.value = '50'; b.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 80));
    return { attendu: brutA * 0.2 + brutB * 0.5, affiche: document.querySelector('#simEco').textContent };
  });
  verifier('les réductions se cumulent',
    Math.abs(montant(cumul.affiche) - cumul.attendu) <= 2,
    cumul.affiche + ' attendu ' + Math.round(cumul.attendu));

  const raz = await page.evaluate(async () => {
    document.querySelector('#btnRaz').click();
    await new Promise(r => setTimeout(r, 80));
    return { eco: document.querySelector('#simEco').textContent.trim(),
             vides: [...document.querySelectorAll('input.red')].every(i => i.value === '') };
  });
  verifier('Effacer remet tout à zéro', raz.eco === '—' && raz.vides, 'éco : ' + raz.eco);

  console.log('\nDéploiement global et export');
  const tout = await page.evaluate(async () => {
    document.querySelector('#btnTout').click();
    await new Promise(r => setTimeout(r, 100));
    const l = [...document.querySelectorAll('table.pl tbody tr')];
    return { visibles: l.filter(t => !t.classList.contains('cache')).length, total: l.length };
  });
  verifier('tout déployer montre toutes les lignes', tout.visibles === tout.total, tout.visibles + '/' + tout.total);

  const dl = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    page.click('#btnCsv'),
  ]).then(r => r[0]);
  verifier('l\'export CSV produit un fichier', dl !== null, dl ? dl.suggestedFilename() : 'aucun');

  console.log('\nMouvements de bilan');
  const bilan = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('tr.n0')].find(t => t.textContent.includes('BILAN'));
    if (!tr) return { present: false };
    const res = [...document.querySelectorAll('tr.total')].find(t => t.textContent.includes('RÉSULTAT NET'));
    const lignes = [...document.querySelectorAll('table.pl tbody tr')];
    return { present: true, apresResultat: lignes.indexOf(tr) > lignes.indexOf(res) };
  });
  if (bilan.present) verifier('la section hors résultat est placée après le résultat net', bilan.apresResultat);
  else console.log('  (aucun mouvement de bilan dans ce jeu de contrôle)');

  console.log('\nErreurs JavaScript');
  verifier('aucune erreur console', erreursJs.length === 0, erreursJs.join(' | '));

  await nav.close();
  nettoyer();
  console.log('\n' + reussis + ' réussis, ' + echecs + ' échecs');
  process.exit(echecs ? 1 : 0);
})().catch(e => { console.error('Échec du harnais : ' + e.message); process.exit(1); });
