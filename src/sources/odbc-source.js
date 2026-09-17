// Source « base de donnees » — lit Avantage directement par ODBC, sans passer
// par l'export Excel. Le module odbc est charge paresseusement: si le driver
// n'est pas installe, le bridge bascule sur la source xlsx au lieu de tomber.
const { SCHEMA } = require('./schema');

let odbc = null;
function getOdbc() {
  if (odbc) return odbc;
  try { odbc = require('odbc'); } catch (e) {
    throw new Error("Module 'odbc' absent — installer avec: npm install odbc (ou garder AVANTAGE_SOURCE=xlsx)");
  }
  return odbc;
}

function connectionString() {
  if (process.env.ODBC_CONNECTION_STRING) return process.env.ODBC_CONNECTION_STRING;
  if (process.env.ODBC_DSN) {
    let cs = 'DSN=' + process.env.ODBC_DSN + ';';
    if (process.env.ODBC_UID) cs += 'UID=' + process.env.ODBC_UID + ';';
    if (process.env.ODBC_PWD) cs += 'PWD=' + process.env.ODBC_PWD + ';';
    return cs;
  }
  throw new Error('ODBC_DSN ou ODBC_CONNECTION_STRING doit etre defini pour AVANTAGE_SOURCE=odbc');
}

const txt = v => (v == null ? '' : String(v)).trim();
const act = v => txt(v).replace(/\.00$/, '');
const num = v => (typeof v === 'number' ? v : parseFloat(txt(v).replace(',', '.'))) || 0;
const dat = v => (v instanceof Date ? v.toISOString().slice(0, 10) : txt(v).replace(/\//g, '-').slice(0, 10));

function quote(id) {
  const q = process.env.ODBC_QUOTE;
  if (q === 'none') return id;
  if (q === 'bracket') return '[' + id + ']';
  return '"' + id.replace(/"/g, '""') + '"';
}

// Resout une colonne logique vers son nom reel dans la table.
function resolveColumn(spec, colonnes) {
  const lower = colonnes.map(c => ({ nom: c, bas: c.toLowerCase() }));
  for (const n of (spec.names || [])) {
    const hit = lower.find(c => c.bas === n.toLowerCase());
    if (hit) return hit.nom;
  }
  for (const f of (spec.match || [])) {
    const hit = lower.find(c => c.bas.includes(f.toLowerCase()));
    if (hit) return hit.nom;
  }
  return null;
}

function resolveTable(def, colonnes) {
  const map = {};
  const manquantes = [];
  for (const [logique, spec] of Object.entries(def.columns)) {
    const reel = resolveColumn(spec, colonnes);
    if (reel) map[logique] = reel; else manquantes.push(logique);
  }
  return { map, manquantes };
}

// Paires GL/montant de ventilation: colonnes portant le meme suffixe numerique.
function detectVentilation(colonnes) {
  const paires = [];
  for (const c of colonnes) {
    const m = c.match(/^(.*?)(\d{1,2})$/);
    if (!m) continue;
    const base = m[1].toLowerCase();
    if (!/gl|compte/.test(base)) continue;
    const idx = m[2];
    const mt = colonnes.find(o => {
      const mo = o.match(/^(.*?)(\d{1,2})$/);
      return mo && mo[2] === idx && /mnt|montant/.test(mo[1].toLowerCase());
    });
    if (mt) paires.push({ gl: c, montant: mt });
  }
  return paires;
}

async function columnsOf(cnx, table) {
  const r = await cnx.query('SELECT * FROM ' + quote(table) + ' WHERE 1 = 0');
  return (r.columns || []).map(c => ({ nom: c.name, type: c.dataType, numerique: /int|num|dec|float|double|real|money/i.test(String(c.dataTypeName || c.dataType || '')) }));
}

function litteralProjets(codes, colonneNumerique) {
  const vals = new Set();
  for (const c of codes) {
    const t = String(c).replace(/^P/i, '').trim();
    const n = parseInt(t, 10);
    if (!Number.isFinite(n)) continue;
    if (colonneNumerique) vals.add(String(n));
    else { vals.add("'" + t + "'"); vals.add("'" + String(n) + "'"); vals.add("'" + String(n).padStart(10, '0') + "'"); }
  }
  return [...vals].join(', ');
}

// Lit une table logique, en poussant le filtre projet dans le SQL quand possible.
async function readTable(cnx, cle, codes) {
  const def = SCHEMA[cle];
  const colonnes = await columnsOf(cnx, def.table);
  const noms = colonnes.map(c => c.nom);
  const { map, manquantes } = resolveTable(def, noms);
  const ventilation = def.ventilation ? detectVentilation(noms) : [];

  const select = Object.values(map).map(quote);
  ventilation.forEach(p => { select.push(quote(p.gl)); select.push(quote(p.montant)); });
  if (!select.length) throw new Error('Aucune colonne resolue pour ' + def.table);

  let sql = 'SELECT ' + select.join(', ') + ' FROM ' + quote(def.table);
  const colProjet = map.projet;
  if (colProjet && codes && codes.length) {
    const meta = colonnes.find(c => c.nom === colProjet);
    const liste = litteralProjets(codes, meta && meta.numerique);
    if (liste) sql += ' WHERE ' + quote(colProjet) + ' IN (' + liste + ')';
  }

  let rows;
  try {
    rows = await cnx.query(sql);
  } catch (e) {
    // Filtre refuse (type de colonne inattendu): on relit sans filtre.
    console.error('[WARN] ' + def.table + ' — filtre SQL refuse (' + e.message + '), lecture complete');
    rows = await cnx.query('SELECT ' + select.join(', ') + ' FROM ' + quote(def.table));
  }

  return { rows: Array.from(rows), map, ventilation, manquantes, table: def.table };
}

function pick(row, map, logique) {
  const col = map[logique];
  return col === undefined ? '' : row[col];
}

async function withConnection(fn) {
  const cnx = await getOdbc().connect(connectionString());
  try { return await fn(cnx); } finally { try { await cnx.close(); } catch (e) {} }
}

async function loadProjets() {
  return withConnection(async cnx => {
    const p = await readTable(cnx, 'projets', null);
    const f = await readTable(cnx, 'facturesClient', null);
    return {
      source: 'odbc',
      projets: p.rows.map(r => ({
        numero: txt(pick(r, p.map, 'numero')), nom: txt(pick(r, p.map, 'nom')),
        client: txt(pick(r, p.map, 'client')), statut: txt(pick(r, p.map, 'statut')),
        date_debut: dat(pick(r, p.map, 'date_debut')), date_fin_prevue: dat(pick(r, p.map, 'date_fin_prevue')),
        solde: num(pick(r, p.map, 'solde')), profit: num(pick(r, p.map, 'profit')),
      })),
      facturesClient: f.rows.map(r => ({
        numero_facture: txt(pick(r, f.map, 'numero_facture')), projet: txt(pick(r, f.map, 'projet')),
        client: txt(pick(r, f.map, 'client')), date: dat(pick(r, f.map, 'date')),
        date_echeance: dat(pick(r, f.map, 'date_echeance')), total: num(pick(r, f.map, 'total')),
        solde: num(pick(r, f.map, 'solde')), retenue: num(pick(r, f.map, 'retenue')),
      })),
      colonnes_manquantes: { projets: p.manquantes, facturesClient: f.manquantes },
    };
  });
}

async function loadDetail(codes) {
  return withConnection(async cnx => {
    const a = await readTable(cnx, 'activites', null);
    const b = await readTable(cnx, 'budget', codes);
    const fa = await readTable(cnx, 'facturationActivite', codes);
    const t = await readTable(cnx, 'transactions', codes);
    const ff = await readTable(cnx, 'facturesFournisseur', codes);
    const ci = await readTable(cnx, 'commandeItems', null);
    const cm = await readTable(cnx, 'commandes', codes);

    return {
      source: 'odbc',
      lu_a: new Date().toISOString(),
      age_heures: 0,
      activites: a.rows.map(r => ({ code: act(pick(r, a.map, 'code')), nom: txt(pick(r, a.map, 'nom')) }))
        .filter(x => x.code)
        .map(x => ({ code: x.code, nom: x.nom || x.code })),
      budget: b.rows.map(r => ({ projet: txt(pick(r, b.map, 'projet')), activite: act(pick(r, b.map, 'activite')), montant: num(pick(r, b.map, 'montant')) })),
      facturationActivite: fa.rows.map(r => ({
        projet: txt(pick(r, fa.map, 'projet')), activite: act(pick(r, fa.map, 'activite')),
        facture: num(pick(r, fa.map, 'facture')), depense_a_venir: num(pick(r, fa.map, 'depense_a_venir')),
      })),
      transactions: t.rows.map(r => ({
        projet: txt(pick(r, t.map, 'projet')), gl: txt(pick(r, t.map, 'gl')), date: dat(pick(r, t.map, 'date')),
        journal: txt(pick(r, t.map, 'journal')), montant: num(pick(r, t.map, 'montant')), activite: act(pick(r, t.map, 'activite')),
      })),
      facturesFournisseur: ff.rows.map(r => ({
        seq: txt(pick(r, ff.map, 'seq')), date: dat(pick(r, ff.map, 'date')),
        no_facture: txt(pick(r, ff.map, 'no_facture')), description: txt(pick(r, ff.map, 'description')),
        montant_total: num(pick(r, ff.map, 'montant_total')), projet: txt(pick(r, ff.map, 'projet')),
        no_commande: txt(pick(r, ff.map, 'no_commande')), fournisseur: txt(pick(r, ff.map, 'fournisseur')),
        ventilation: ff.ventilation.map(p => ({ gl: txt(r[p.gl]), montant: num(r[p.montant]) })).filter(x => x.gl),
      })),
      commandeItems: ci.rows.map(r => ({ no_commande: txt(pick(r, ci.map, 'no_commande')), activite: act(pick(r, ci.map, 'activite')) })),
      commandes: cm.rows.map(r => ({
        projet: txt(pick(r, cm.map, 'projet')), seq: txt(pick(r, cm.map, 'seq')),
        seq_commande: txt(pick(r, cm.map, 'seq_commande')), no_fournisseur: txt(pick(r, cm.map, 'no_fournisseur')),
        nom_fournisseur: txt(pick(r, cm.map, 'nom_fournisseur')) || txt(pick(r, cm.map, 'no_fournisseur')),
        sous_total: num(pick(r, cm.map, 'sous_total')), statut: txt(pick(r, cm.map, 'statut')),
      })),
      colonnes_manquantes: Object.fromEntries(
        [['activites', a], ['budget', b], ['facturationActivite', fa], ['transactions', t],
         ['facturesFournisseur', ff], ['commandeItems', ci], ['commandes', cm]]
          .filter(([, v]) => v.manquantes.length).map(([k, v]) => [k, v.manquantes])),
    };
  });
}

// Rien a preparer: la BD est deja la source de verite.
function prepare() { return { ok: true, skipped: true, reason: 'lecture directe de la BD Avantage', files: [] }; }

async function ping() {
  return withConnection(async cnx => {
    const r = await cnx.query('SELECT ' + quote(SCHEMA.projets.columns.numero.names[0]) + ' FROM ' + quote(SCHEMA.projets.table) + ' WHERE 1 = 0');
    return { ok: true, colonnes: (r.columns || []).map(c => c.name) };
  });
}

module.exports = { loadProjets, loadDetail, prepare, ping, withConnection, readTable, resolveTable, resolveColumn, detectVentilation, columnsOf, connectionString, quote };
