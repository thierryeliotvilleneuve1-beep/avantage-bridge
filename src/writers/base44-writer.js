const https = require('https');

const APP_ID = process.env.BASE44_APP_ID || '68927e133cde9f63295dd616';
const PAGE_SIZE = parseInt(process.env.BASE44_PAGE_SIZE, 10) || 500;

function api(method, path, body) {
  return new Promise((res) => {
    const o = {
      hostname: 'app.base44.com',
      path: '/api/apps/' + APP_ID + path,
      method,
      headers: { 'api_key': process.env.BASE44_API_KEY, 'Content-Type': 'application/json' }
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

// GET pagine — indispensable: au-dela de 500 enregistrements, un GET simple
// ne voit pas les lignes existantes et le upsert recree des doublons.
async function apiGetAll(entity, extraQuery) {
  const out = [];
  const seen = new Set();
  let skip = 0;
  for (let page = 0; page < 200; page++) {
    const q = '/entities/' + entity + '?limit=' + PAGE_SIZE + '&skip=' + skip + (extraQuery ? '&' + extraQuery : '');
    let r = await api('GET', q);
    if (r.status === 429) { await sleep(1500); r = await api('GET', q); }
    if (r.status !== 200) break;
    const arr = toArray(r.data);
    if (!arr.length) break;
    // Si l'API ignore "skip", la page revient identique — on arrete au lieu de boucler.
    let fresh = 0;
    for (const x of arr) {
      const id = idOf(x);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(x);
      fresh++;
    }
    if (fresh === 0) break;
    if (arr.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
    await sleep(120);
  }
  return out;
}

// Ecriture avec retry sur 429 et sur erreur reseau transitoire.
async function upsert(entity, existingId, payload) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = existingId
      ? await api('PUT', '/entities/' + entity + '/' + existingId, payload)
      : await api('POST', '/entities/' + entity, payload);
    if (r.status === 200 || r.status === 201) {
      let body = null;
      try { body = JSON.parse(r.data); } catch (e) {}
      return { ok: true, status: r.status, body };
    }
    if (r.status === 429 || r.status === 0 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    return { ok: false, status: r.status, data: r.data };
  }
  return { ok: false, status: 429 };
}

async function writeProjets(projets) {
  let created = 0, updated = 0, errors = 0;
  const existingArr = await apiGetAll('Projet');

  for (const p of projets) {
    if (!p.numero_projet) continue;
    const code = p.numero_projet.replace(/^0+/, '').padStart(5, '0').slice(-5);
    const found = existingArr.find(x => (x.code_projet || '').includes(code) || (x.code_projet || '') === p.numero_projet);
    const payload = {
      code_projet: p.numero_projet,
      nom: p.nom_projet || p.numero_projet,
      statut: p.statut || 'actif',
      sync_avantage_ts: new Date().toISOString(),
    };
    const r = await upsert('Projet', found ? idOf(found) : null, payload);
    if (r.ok) { found ? updated++ : created++; } else errors++;
    await sleep(100);
  }
  return { created, updated, errors, total: projets.length };
}

async function writeFactures(factures) {
  let created = 0, updated = 0, errors = 0;
  const existingArr = await apiGetAll('FactureClient');

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
      sync_avantage_ts: new Date().toISOString(),
    };
    const r = await upsert('FactureClient', found ? idOf(found) : null, payload);
    if (r.ok) { found ? updated++ : created++; } else errors++;
    await sleep(100);
  }
  return { created, updated, errors, total: factures.length };
}

module.exports = { writeProjets, writeFactures, api, apiGetAll, upsert, toArray, idOf, sleep };
