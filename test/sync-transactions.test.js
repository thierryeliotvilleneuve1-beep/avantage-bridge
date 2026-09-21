// Bout en bout : fichiers .DBF Avantage → transactions dans Manoeuvre (Base44 simulé).
// Vérifie que le sync lit la BASE en direct, exclut les taxes, écarte les supprimés et
// les types de journal non retenus, regroupe par projet et ne crée pas de doublons.
//
// Lancer : node test/sync-transactions.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-dbf-'));
process.env.AVANTAGE_DBF_DIR = DIR;
process.env.AVANTAGE_EXPORT_DIR = path.join(DIR, 'aucun-export');
process.env.AVANTAGE_BD_ACTIVE = 'false';
process.env.BASE44_API_KEY = 'test';
process.env.BASE44_APP_ID = 'test';

let echecs = 0;
function check(nom, reel, attendu) {
  const ok = JSON.stringify(reel) === JSON.stringify(attendu);
  if (!ok) { echecs++; console.log('  ÉCHEC ' + nom + ' — attendu ' + JSON.stringify(attendu) + ', obtenu ' + JSON.stringify(reel)); }
  else console.log('  ok    ' + nom + ' = ' + JSON.stringify(reel));
}

// ── Jeu de tables .DBF ────────────────────────────────────────────────────────
const aide = require('./aide-dbf');
const ecrireDbf = aide.pour(DIR);

ecrireDbf('PYBBIL.DBF', aide.champsPybbil(), [
  aide.lignePybbil({ seq: '1001', date: '20260210', noFourn: 'F01', facture: 'ST-1', desc: 'Charpente',
    total: '300000.00', projet: '0000025007', commande: '000002087', nom: 'GROUPE JLF', gl: [['33500', '300000.00']] }),
  // Matériaux avec taxes : seul le net (40000) doit compter
  aide.lignePybbil({ seq: '1002', date: '20260312', noFourn: 'F02', facture: 'MT-1', desc: 'Acier',
    total: '45990.00', projet: '0000026004', nom: 'BOULAY INOX', gl: [['33200', '40000.00'], ['21300', '2000.00'], ['21340', '3990.00']] }),
  // Supprimé : jamais compté
  aide.lignePybbil({ seq: '1003', date: '20260313', noFourn: 'F03', facture: 'ANNULE', desc: 'Annule',
    total: '888888.00', projet: '0000025007', nom: 'NE PAS VOIR', gl: [['33500', '888888.00']], supprime: true }),
  // Frais général sans projet : hors transactions de projet
  aide.lignePybbil({ seq: '2001', date: '20260120', noFourn: 'G01', facture: 'FG-1', desc: 'Info',
    total: '50000.00', nom: 'BLACKWARE', gl: [['42120', '50000.00']] }),
  // Projet présent dans les transactions mais ABSENT de Manoeuvre → doit être ignoré
  aide.lignePybbil({ seq: '3001', date: '20260201', noFourn: 'F09', facture: 'X-1', desc: 'Vieux projet',
    total: '10000.00', projet: '0000099999', nom: 'ANCIEN', gl: [['33500', '10000.00']] }),
]);

ecrireDbf('TRANS.DBF', aide.CHAMPS_TRANS, [
  aide.ligneTrans({ projet: '0000025007', compte: '34100', date: '20260301', type: 'E', seq: 101, montant: '100000.00', activite: '06100' }),
  aide.ligneTrans({ projet: '', compte: '43100', date: '20260201', type: 'E', seq: 102, montant: '80000.00' }),
  aide.ligneTrans({ projet: '0000025007', compte: '34100', date: '20260302', type: 'X', seq: 103, montant: '55555.00', activite: '06100' }),
]);

ecrireDbf('FACTMA.DBF', [
  { nom: 'FFNOFACT', type: 'C', longueur: 10 }, { nom: 'FFCONT', type: 'C', longueur: 10 },
  { nom: 'FFVENTE', type: 'C', longueur: 40 }, { nom: 'FFDATE', type: 'D', longueur: 8 },
  { nom: 'FFTOTDU', type: 'N', longueur: 13, decimales: 2 }, { nom: 'FFSOLDE', type: 'N', longueur: 13, decimales: 2 },
  { nom: 'FFMNTRET', type: 'N', longueur: 13, decimales: 2 }, { nom: 'FFNOTCR', type: 'L', longueur: 1 },
], [
  { FFNOFACT: 'F-001', FFCONT: '0000025007', FFVENTE: 'CNA', FFDATE: '20260331', FFTOTDU: '700000.00', FFSOLDE: '0.00', FFMNTRET: '35000.00', FFNOTCR: 'F' },
  { FFNOFACT: 'F-002', FFCONT: '0000026004', FFVENTE: 'CARPE DIEM', FFDATE: '20260430', FFTOTDU: '200000.00', FFSOLDE: '200000.00', FFMNTRET: '10000.00', FFNOTCR: 'F' },
]);

ecrireDbf('CONTRA.DBF', [
  { nom: 'CONUM', type: 'C', longueur: 10 }, { nom: 'CONOM', type: 'C', longueur: 40 },
  { nom: 'COCLINOM', type: 'C', longueur: 40 }, { nom: 'COSTT', type: 'C', longueur: 2 },
], [
  { CONUM: '0000025007', CONOM: 'TV-18 Atikamekw', COCLINOM: 'CNA', COSTT: 'A' },
  { CONUM: '0000026004', CONOM: 'BD-50 Eglise', COCLINOM: 'CARPE DIEM', COSTT: 'A' },
]);

ecrireDbf('ACTIVE.DBF', [
  { nom: 'ACNUM', type: 'C', longueur: 10 }, { nom: 'ACDESC', type: 'C', longueur: 40 },
], [ { ACNUM: '06100', ACDESC: 'Charpenterie' } ]);

const champsComite = [];
for (let i = 0; i < 18; i++) champsComite.push(i === 16 ? { nom: 'CMCMD', type: 'C', longueur: 9 } : (i === 17 ? { nom: 'CMACT', type: 'C', longueur: 10 } : { nom: 'CMF' + i, type: 'C', longueur: 4 }));
ecrireDbf('COMITE.DBF', champsComite, [ { CMCMD: '000002087', CMACT: '06100' } ]);

// ── Base44 simulé ────────────────────────────────────────────────────────────
const store = { Projet: [], FactureClient: [], ControleBudgetaire: [], BonDeCommande: [], TransactionAvantage: [] };
// Les projets doivent PRÉ-EXISTER dans Manoeuvre — le bridge ne les crée plus.
store.Projet.push({ _id: 'proj-25007', code_projet: 'P25007', nom: 'TV-18 Atikamekw', statut: 'actif' });
store.Projet.push({ _id: 'proj-26004', code_projet: 'P26004', nom: 'BD-50 Eglise', statut: 'actif' });
let seq = 0;
https.request = function (o, cb) {
  const req = new EventEmitter(); let body = '';
  req.write = c => { body += c; };
  req.end = () => {
    const url = o.path.replace(/^\/api\/apps\/[^/]+/, '');
    const [pathname, query] = url.split('?');
    const parts = pathname.split('/').filter(Boolean);
    const entity = parts[1], id = parts[2];
    store[entity] = store[entity] || [];
    let status = 200, payload = {};
    if (o.method === 'GET') {
      const p = new URLSearchParams(query || '');
      const limit = parseInt(p.get('limit'), 10) || 500, skip = parseInt(p.get('skip'), 10) || 0;
      payload = store[entity].slice(skip, skip + limit);
    } else if (o.method === 'POST') {
      const rec = Object.assign({ _id: 'm' + (++seq) }, JSON.parse(body || '{}'));
      store[entity].push(rec); payload = rec; status = 201;
    } else if (o.method === 'PUT') {
      const i = store[entity].findIndex(x => x._id === id);
      if (i === -1) { status = 404; } else { store[entity][i] = Object.assign({}, store[entity][i], JSON.parse(body || '{}')); payload = store[entity][i]; }
    }
    const res = new EventEmitter(); res.statusCode = status;
    process.nextTick(() => { res.emit('data', JSON.stringify(payload)); res.emit('end'); });
    cb(res);
  };
  return req;
};

(async () => {
  const { syncComplet } = require('../src/services/syncComplet');
  const r = await syncComplet();

  console.log('\n--- Résultat du sync ---');
  check('sync ok', r.ok, true);
  check('aucun projet créé (ils préexistent)', r.etapes.projets.created, 0);
  check('projets synchronisés = 2', r.etapes.projets.dans_manoeuvre, 2);
  check('projet 99999 absent, ignoré', r.etapes.projets.absents, 1);
  check('factures créées', r.etapes.factures.created, 2);

  const parNum = {};
  store.Projet.forEach(p => { parNum[p.code_projet] = p._id; });
  check('projet P25007 présent', !!parNum['P25007'], true);
  check('transactions du projet absent 99999 non poussées', store.TransactionAvantage.some(x=>x.numero_journal==='P3001'), false);

  const t = {};
  store.TransactionAvantage.forEach(x => { t[x.numero_journal] = x; });
  const journaux = Object.keys(t).sort();
  console.log('  journaux:', journaux.join(', '));

  check('facture fournisseur ST-1 (net, hors taxes) montant', t['P1001'] && t['P1001'].montant, 300000);
  check('ST-1 division via COMITE', t['P1001'] && t['P1001'].code_division, '06100');
  check('matériaux MT-1 net = 40000 (taxes 2000+3990 exclues)', t['P1002'] && t['P1002'].montant, 40000);
  check('main-d-oeuvre E000101 = 100000', t['E000101'] && t['E000101'].montant, 100000);
  check('E000101 marquée is_mo', t['E000101'] && t['E000101'].is_mo, true);

  check('facture supprimée P1003 absente', !!t['P1003'], false);
  check('journal type X absent', !!t['X000103'], false);
  check('salaire sans projet (E000102) absent des transactions projet', !!t['E000102'], false);
  check('frais général sans projet (P2001) absent', !!t['P2001'], false);

  // Rattachement au bon projet
  check('transactions de 25007', store.TransactionAvantage.filter(x => x.projet_id === parNum['P25007']).map(x => x.numero_journal).sort(), ['E000101', 'P1001']);
  check('transactions de 26004', store.TransactionAvantage.filter(x => x.projet_id === parNum['P26004']).map(x => x.numero_journal).sort(), ['P1002']);

  // Deuxième passage : différentiel — rien n'a changé, donc aucune écriture.
  console.log('\n--- Deuxième passage (différentiel) ---');
  const avant = store.TransactionAvantage.length;
  let ecritures = 0;
  const httpReq = https.request;
  https.request = function (o, cb) {
    if (o.method === 'POST' || o.method === 'PUT') ecritures++;
    return httpReq(o, cb);
  };
  const r2 = await syncComplet();
  check('aucun doublon de transaction', store.TransactionAvantage.length, avant);
  check('transactions toutes inchangées', r2.transactions.unchanged, avant);
  check('aucune transaction réécrite', [r2.transactions.created, r2.transactions.updated], [0, 0]);
  check('2e passage: aucun projet créé', r2.etapes.projets.created, 0);
  check('factures inchangées', r2.etapes.factures.unchanged, 2);
  check('aucune écriture réseau (POST/PUT) au 2e passage', ecritures, 0);

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(echecs ? '\n' + echecs + ' ÉCHEC(S)' : '\nTous les tests passent');
  process.exit(echecs ? 1 : 0);
})();
