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

async function writeProjets(projets) {
  let created = 0, updated = 0, errors = 0;
  const existing = await api('GET', '/entities/Projet?limit=500');
  let existingArr = [];
  try { const d = JSON.parse(existing.data); existingArr = Array.isArray(d) ? d : (d.items || []); } catch (e) {}

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
    let st = 429;
    while (st === 429) {
      const r = found
        ? await api('PUT', '/entities/Projet/' + found._id, payload)
        : await api('POST', '/entities/Projet', payload);
      st = r.status;
      if (st === 429) await sleep(1000);
    }
    if (st === 200 || st === 201) { found ? updated++ : created++; } else errors++;
    await sleep(100);
  }
  return { created, updated, errors };
}

async function writeFactures(factures) {
  let created = 0, updated = 0, errors = 0;
  const existing = await api('GET', '/entities/FactureClient?limit=500');
  let existingArr = [];
  try { const d = JSON.parse(existing.data); existingArr = Array.isArray(d) ? d : (d.items || []); } catch (e) {}

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
    let st = 429;
    while (st === 429) {
      const r = found
        ? await api('PUT', '/entities/FactureClient/' + found._id, payload)
        : await api('POST', '/entities/FactureClient', payload);
      st = r.status;
      if (st === 429) await sleep(1000);
    }
    if (st === 200 || st === 201) { found ? updated++ : created++; } else errors++;
    await sleep(100);
  }
  return { created, updated, errors };
}

module.exports = { writeProjets, writeFactures, api, sleep };
