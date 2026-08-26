'use strict';
const https = require('https');

const HOST = 'app.base44.com';
const APP_ID = process.env.BASE44_APP_ID || '68927e133cde9f63295dd616';
const KEY = process.env.BASE44_API_KEY;

const PAGE_SIZE = Number(process.env.BASE44_PAGE_SIZE || 200);
const MAX_RETRIES = Number(process.env.BASE44_MAX_RETRIES || 6);
const BASE_DELAY = Number(process.env.BASE44_BASE_DELAY_MS || 400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, path, body) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: HOST,
        path: '/api/apps/' + APP_ID + path,
        method,
        headers: { api_key: KEY, 'Content-Type': 'application/json' },
        timeout: 60000,
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, data: d }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: '{"error":"timeout"}' }); });
    req.on('error', (e) => resolve({ status: 0, data: JSON.stringify({ error: e.message }) }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Un appel qui réessaie sur 429 et sur les erreurs réseau, avec backoff exponentiel.
// L'ancien code bouclait indéfiniment sur 429 sans plafond — un incident Base44
// bloquait le bridge pour toujours.
async function api(method, path, body) {
  let attempt = 0;
  for (;;) {
    const res = await request(method, path, body);
    const retriable = res.status === 429 || res.status === 0 || res.status >= 500;
    if (!retriable || attempt >= MAX_RETRIES) return res;
    const wait = BASE_DELAY * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
    attempt++;
    console.warn(`[WARN] ${method} ${path} → ${res.status}, retry ${attempt}/${MAX_RETRIES} dans ${wait}ms`);
    await sleep(wait);
  }
}

function unwrap(res) {
  try {
    const d = JSON.parse(res.data);
    if (Array.isArray(d)) return d;
    if (Array.isArray(d.items)) return d.items;
    if (Array.isArray(d.data)) return d.data;
    return [];
  } catch (e) {
    return [];
  }
}

/**
 * Lit TOUTES les lignes d'une entité, page par page.
 *
 * L'ancien code appelait `?limit=500` une seule fois. Avec 1 291 projets et des
 * milliers de divisions, la liste des enregistrements existants était tronquée
 * en silence : le bridge ne « voyait » pas les lignes au-delà de la 500e, les
 * traitait comme absentes et en recréait des doublons à chaque passage.
 */
async function listAll(entity, { query = '' } = {}) {
  const out = [];
  let skip = 0;
  for (;;) {
    const sep = query ? '&' : '?';
    const path = `/entities/${entity}${query ? '?' + query : ''}${sep}limit=${PAGE_SIZE}&skip=${skip}`;
    const res = await api('GET', path);
    if (res.status !== 200) {
      throw new Error(`Lecture ${entity} échouée (HTTP ${res.status}) : ${res.data.slice(0, 200)}`);
    }
    const page = unwrap(res);
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
    if (skip > 200000) throw new Error(`Pagination ${entity} emballée à ${skip} lignes`);
  }
  return out;
}

const idOf = (row) => row._id || row.id;

async function create(entity, payload) {
  const res = await api('POST', `/entities/${entity}`, payload);
  return { ok: res.status === 200 || res.status === 201, status: res.status, body: res.data };
}

async function update(entity, id, payload) {
  const res = await api('PUT', `/entities/${entity}/${id}`, payload);
  return { ok: res.status === 200 || res.status === 201, status: res.status, body: res.data };
}

async function remove(entity, id) {
  const res = await api('DELETE', `/entities/${entity}/${id}`);
  return { ok: res.status === 200 || res.status === 204, status: res.status };
}

module.exports = { api, listAll, create, update, remove, idOf, unwrap, sleep, APP_ID };
