const https = require('https');

const BASE44_KEY = process.env.BASE44_API_KEY;
const APP_ID = process.env.BASE44_APP_ID || '68927e133cde9f63295dd616';

function api(method, path, body) {
  return new Promise((res) => {
    const o = {
      hostname: 'app.base44.com',
      path: '/api/apps/' + APP_ID + path,
      method,
      headers: { 'api_key': BASE44_KEY, 'Content-Type': 'application/json' }
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toArray(raw) {
  try { const d = JSON.parse(raw); return Array.isArray(d) ? d : (d.items || []); } catch (e) { return []; }
}

function idOf(x) { return x._id || x.id; }

// Deux valeurs equivalentes ? Tolerance numerique pour les montants, '' == null pour le reste.
function memeValeur(x, y) {
  if (typeof x === 'number' || typeof y === 'number') {
    return Math.abs((Number(x) || 0) - (Number(y) || 0)) < 0.005;
  }
  return String(x == null ? '' : x) === String(y == null ? '' : y);
}

// L'enregistrement existant porte-t-il deja exactement ces valeurs ? Si oui, ne rien
// reecrire : c'est ce qui rend la synchro differentielle (on ne pousse que ce qui change).
function inchange(existant, payload, champs) {
  if (!existant) return false;
  return champs.every(c => memeValeur(existant[c], payload[c]));
}

// GET pagine. Indispensable : au-dela de 500 enregistrements, un simple limit=500 ne voit
// pas les lignes existantes et l'upsert recree des doublons a chaque sync.
async function apiGetAll(entity, extraQuery) {
  const PAGE = 500;
  const out = [];
  const vus = new Set();
  let skip = 0;
  for (let page = 0; page < 500; page++) {
    const q = '/entities/' + entity + '?limit=' + PAGE + '&skip=' + skip + (extraQuery ? '&' + extraQuery : '');
    let r = await api('GET', q);
    if (r.status === 429) { await sleep(1500); r = await api('GET', q); }
    if (r.status !== 200) break;
    const arr = toArray(r.data);
    if (!arr.length) break;
    let neufs = 0;
    for (const x of arr) {
      const id = idOf(x);
      if (id && vus.has(id)) continue;
      if (id) vus.add(id);
      out.push(x); neufs++;
    }
    if (neufs === 0 || arr.length < PAGE) break;
    skip += PAGE;
    await sleep(120);
  }
  return out;
}

// Upsert avec reprise sur 429 et erreur reseau transitoire.
async function upsert(entity, existingId, payload) {
  for (let essai = 0; essai < 6; essai++) {
    const r = existingId
      ? await api('PUT', '/entities/' + entity + '/' + existingId, payload)
      : await api('POST', '/entities/' + entity, payload);
    if (r.status === 200 || r.status === 201) {
      let body = null; try { body = JSON.parse(r.data); } catch (e) {}
      return { ok: true, status: r.status, body };
    }
    if (r.status === 429 || r.status === 0 || r.status >= 500) { await sleep(1500 * (essai + 1)); continue; }
    return { ok: false, status: r.status, data: r.data };
  }
  return { ok: false, status: 429 };
}

async function writeProjets(projets) {
  let created = 0, updated = 0, unchanged = 0, errors = 0;
  const existingArr = await apiGetAll('Projet');

  for (const p of projets) {
    if (!p.numero_projet) continue;
    const code = p.numero_projet.replace(/^0+/, '').padStart(5, '0').slice(-5);
    const found = existingArr.find(x => (x.code_projet || '').includes(code) || (x.code_projet || '') === p.numero_projet);
    const payload = {
      code_projet: p.numero_projet,
      nom: p.nom_projet || p.numero_projet,
      statut: p.statut || 'actif',
    };
    if (inchange(found, payload, ['code_projet', 'nom', 'statut'])) { unchanged++; continue; }
    payload.sync_avantage_ts = new Date().toISOString();
    const r = await upsert('Projet', found ? idOf(found) : null, payload);
    if (r.ok) { found ? updated++ : created++; } else errors++;
    await sleep(80);
  }
  return { created, updated, unchanged, errors };
}

async function writeFactures(factures) {
  let created = 0, updated = 0, unchanged = 0, errors = 0;
  const existingArr = await apiGetAll('FactureClient');
  const CHAMPS = ['numero_facture', 'code_projet', 'client_nom', 'date_facture', 'total_facture', 'solde_ouvert', 'retenue_total', 'statut_paiement'];

  for (const f of factures) {
    if (!f.numero_facture) continue;
    const found = existingArr.find(x => x.numero_facture === f.numero_facture);
    const payload = {
      numero_facture: f.numero_facture,
      code_projet: f.numero_projet,
      client_nom: f.client_nom,
      date_facture: f.date_facture,
      total_facture: f.total_facture,
      solde_ouvert: f.solde_ouvert,
      retenue_total: f.retenue_total,
      statut_paiement: f.statut_paiement,
    };
    if (inchange(found, payload, CHAMPS)) { unchanged++; continue; }
    payload.sync_avantage_ts = new Date().toISOString();
    const r = await upsert('FactureClient', found ? idOf(found) : null, payload);
    if (r.ok) { found ? updated++ : created++; } else errors++;
    await sleep(80);
  }
  return { created, updated, unchanged, errors };
}

module.exports = { writeProjets, writeFactures, api, apiGetAll, upsert, toArray, idOf, inchange, memeValeur, sleep };
