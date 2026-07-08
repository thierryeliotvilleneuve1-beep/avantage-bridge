// Corrige les DOUBLONS du contrôle budgétaire d'un projet — sans re-sync.
// Garde la première ligne de chaque division, supprime les copies. Les
// montants restants sont ceux déjà en place (identiques entre copies).
//
//   node scripts/dedupe-budget.js P26010
//
// Ne dépend PAS des données Avantage : utilisable depuis n'importe quelle
// machine avec Node + la clé Base44 (.env du dépôt ou variable d'environnement
// BASE44_API_KEY). Pour remettre les montants au niveau de la DB Avantage,
// enchaîner ensuite avec scripts/resync-projet.js sur la machine du bridge.

require('dotenv').config();
const https = require('https');

const CODE = (process.argv[2] || '').trim();
const BASE44_KEY = process.env.BASE44_API_KEY;
const APP_ID = process.env.BASE44_APP_ID || '68927e133cde9f63295dd616';

function api(method, p) {
  return new Promise((res) => {
    const r = https.request({
      hostname: 'app.base44.com',
      path: '/api/apps/' + APP_ID + p,
      method,
      headers: { 'api_key': BASE44_KEY },
    }, re => {
      let d = '';
      re.on('data', c => d += c);
      re.on('end', () => res({ status: re.statusCode, data: d }));
    });
    r.on('error', e => res({ status: 0, data: JSON.stringify({ error: e.message }) }));
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

// Garde la première ligne par code_division (même ordre que le sync utilise
// pour rattacher les transactions), renvoie les ids à supprimer.
function planifierSuppressions(rows) {
  const gardees = {};
  const aSupprimer = [];
  for (const x of rows) {
    const id = x._id || x.id;
    if (gardees[x.code_division]) aSupprimer.push({ id, code_division: x.code_division });
    else gardees[x.code_division] = id;
  }
  return { gardees, aSupprimer };
}

async function main() {
  if (!CODE) { console.error('Usage: node scripts/dedupe-budget.js <code_projet>'); process.exit(1); }
  if (!BASE44_KEY) { console.error('BASE44_API_KEY manquante (.env ou variable d\'environnement)'); process.exit(1); }
  const projets = lireListe(await api('GET', '/entities/Projet?limit=500'));
  const cibles = projets.filter(p => normaliser(p.code_projet) === normaliser(CODE));
  if (!cibles.length) { console.error('Aucune fiche Projet Base44 pour ' + CODE); process.exit(1); }
  if (cibles.length > 1) {
    console.warn('ATTENTION : ' + cibles.length + ' fiches Projet pour ' + CODE + ' (à dédoublonner aussi) :');
    cibles.forEach(p => console.warn('  -', p._id || p.id, '|', p.code_projet, '|', p.nom || ''));
  }

  // Lignes de toutes les fiches correspondantes, dans l'ordre des fiches.
  let rows = [];
  for (const p of cibles) {
    const pid = p._id || p.id;
    const r = lireListe(await api('GET', '/entities/ControleBudgetaire?projet_id=' + encodeURIComponent(pid) + '&limit=1000'))
      .filter(x => x.projet_id === pid);
    rows = rows.concat(r);
  }
  console.log(CODE + ' : ' + rows.length + ' lignes de contrôle budgétaire trouvées.');

  const { gardees, aSupprimer } = planifierSuppressions(rows);
  console.log(Object.keys(gardees).length + ' divisions uniques, ' + aSupprimer.length + ' doublons à supprimer.');
  if (!aSupprimer.length) { console.log('Rien à corriger.'); return; }

  let supprimees = 0;
  for (const x of aSupprimer) {
    let r = await api('DELETE', '/entities/ControleBudgetaire/' + x.id);
    while (r.status === 429) { await sleep(1500); r = await api('DELETE', '/entities/ControleBudgetaire/' + x.id); }
    if (r.status === 200 || r.status === 204) { supprimees++; console.log('  supprimé doublon division ' + x.code_division + ' (' + x.id + ')'); }
    else console.error('  ÉCHEC division ' + x.code_division + ' (' + x.id + ') : HTTP ' + r.status);
    await sleep(100);
  }
  console.log('Terminé : ' + supprimees + '/' + aSupprimer.length + ' doublons supprimés. Chaque division n\'apparaît plus qu\'une fois.');
}

if (require.main === module) main();
module.exports = { planifierSuppressions, normaliser };
