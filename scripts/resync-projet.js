// Nettoie et resynchronise le controle budgetaire d'un projet, tel qu'Avantage.
//
//   node scripts/resync-projet.js P26010
//   node scripts/resync-projet.js P26010 --purge-seulement   (pas de re-sync)
//
// A executer sur la machine du bridge (celle qui a .env et exports-avantage/),
// avec le bridge demarre (npm start) pour l'etape re-sync.
//
// Etapes :
//   1. Trouve la ou les fiches Projet Base44 correspondant au code (match strict).
//   2. Supprime TOUTES les lignes ControleBudgetaire de ce ou ces projet_id.
//   3. Rappelle la route /api/budget/sync/<code> du bridge local, qui recree
//      les divisions depuis les exports Avantage (version corrigee anti-doublon).

require('dotenv').config();
const https = require('https');
const http = require('http');

const CODE = (process.argv[2] || '').trim();
const PURGE_SEULEMENT = process.argv.includes('--purge-seulement');
if (!CODE) { console.error('Usage: node scripts/resync-projet.js <code_projet> [--purge-seulement]'); process.exit(1); }

const BASE44_KEY = process.env.BASE44_API_KEY;
const APP_ID = process.env.BASE44_APP_ID || '68927e133cde9f63295dd616';
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
if (!BASE44_KEY) { console.error('BASE44_API_KEY manquante (.env)'); process.exit(1); }

function api(method, p, body) {
  return new Promise((res) => {
    const o = {
      hostname: 'app.base44.com',
      path: '/api/apps/' + APP_ID + p,
      method,
      headers: { 'api_key': BASE44_KEY, 'Content-Type': 'application/json' },
    };
    const r = https.request(o, re => {
      let d = '';
      re.on('data', c => d += c);
      re.on('end', () => res({ status: re.statusCode, data: d }));
    });
    r.on('error', e => res({ status: 0, data: JSON.stringify({ error: e.message }) }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function lireListe(r) {
  try { const d = JSON.parse(r.data); return Array.isArray(d) ? d : (d.items || []); } catch (e) { return []; }
}

function normaliser(c) {
  return String(c || '').toUpperCase().trim().replace(/^P/, '').replace(/^0+/, '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  // 1. Fiches Projet correspondantes (match strict)
  const projets = lireListe(await api('GET', '/entities/Projet?limit=500'));
  const cibles = projets.filter(p => normaliser(p.code_projet) === normaliser(CODE));
  if (!cibles.length) { console.error('Aucune fiche Projet Base44 pour ' + CODE); process.exit(1); }
  console.log('Fiches Projet trouvées pour ' + CODE + ' : ' + cibles.length);
  if (cibles.length > 1) {
    console.warn('ATTENTION : fiches Projet en double — a dedoublonner dans Base44 :');
    cibles.forEach(p => console.warn('  -', p._id || p.id, '|', p.code_projet, '|', p.nom || ''));
  }

  // 2. Purge des lignes ControleBudgetaire de ces projets
  let totalSupprime = 0;
  for (const p of cibles) {
    const pid = p._id || p.id;
    while (true) {
      const rows = lireListe(await api('GET', '/entities/ControleBudgetaire?projet_id=' + encodeURIComponent(pid) + '&limit=1000'))
        .filter(x => x.projet_id === pid);
      if (!rows.length) break;
      for (const x of rows) {
        const r = await api('DELETE', '/entities/ControleBudgetaire/' + (x._id || x.id));
        if (r.status === 200 || r.status === 204) totalSupprime++;
        else if (r.status === 429) { await sleep(1500); }
        await sleep(100);
      }
      console.log('  ...' + totalSupprime + ' lignes supprimées (projet_id ' + pid + ')');
    }
  }
  console.log('Purge terminée : ' + totalSupprime + ' lignes ControleBudgetaire supprimées.');

  if (PURGE_SEULEMENT) { console.log('Mode --purge-seulement : pas de re-sync.'); return; }

  // 3. Re-sync via le bridge local (lit les exports Avantage)
  if (!API_KEY) { console.error('API_KEY manquante (.env) — lancer le re-sync a la main : POST /api/budget/sync/' + normaliser(CODE)); process.exit(1); }
  const resync = await new Promise((res) => {
    const r = http.request({
      hostname: 'localhost', port: PORT,
      path: '/api/budget/sync/' + normaliser(CODE),
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
    }, re => {
      let d = '';
      re.on('data', c => d += c);
      re.on('end', () => res({ status: re.statusCode, data: d }));
    });
    r.on('error', e => res({ status: 0, data: e.message }));
    r.end();
  });
  if (resync.status === 0) {
    console.error('Bridge injoignable sur localhost:' + PORT + ' (' + resync.data + ') — demarrer le bridge (npm start) puis relancer, ou :');
    console.error('  curl -X POST -H "x-api-key: $API_KEY" http://localhost:' + PORT + '/api/budget/sync/' + normaliser(CODE));
    process.exit(1);
  }
  console.log('Re-sync : ' + resync.data);
})();
