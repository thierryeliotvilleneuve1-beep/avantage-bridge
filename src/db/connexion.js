// Connexion ODBC en LECTURE SEULE à la base Avantage.
//
// Le module `odbc` parle à n'importe quel pilote installé sur la machine : Actian Zen /
// Pervasive, SQL Server, Sybase, Firebird. Le moteur exact n'a donc pas à être connu
// à la compilation — seul le DSN change.
//
// Configuration (.env) :
//   AVANTAGE_DSN=AVA01                 nom du DSN ODBC, ou chaîne de connexion complète
//   AVANTAGE_BD_UTILISATEUR=lecture    optionnel
//   AVANTAGE_BD_MOTDEPASSE=...         optionnel
//   AVANTAGE_BD_DIALECTE=auto          auto | zen | mssql | sybase | generique
//   AVANTAGE_BD_ACTIVE=true            garde-fou : sans ça, le bridge reste sur les CSV
//
// SÉCURITÉ — la base Avantage est la comptabilité de production. Ce module refuse toute
// requête qui n'est pas un SELECT, et la connexion est demandée en lecture seule.

let odbc = null;
try { odbc = require('odbc'); } catch (e) { /* dépendance absente : mode CSV seulement */ }

const DSN = process.env.AVANTAGE_DSN || '';
const UTILISATEUR = process.env.AVANTAGE_BD_UTILISATEUR || '';
const MOTDEPASSE = process.env.AVANTAGE_BD_MOTDEPASSE || '';
const DIALECTE_CONFIG = (process.env.AVANTAGE_BD_DIALECTE || 'auto').toLowerCase();
const ACTIVE = String(process.env.AVANTAGE_BD_ACTIVE || '').toLowerCase() === 'true';

// Seules ces formes sont autorisées. Tout le reste est rejeté avant d'atteindre le pilote.
const SELECT_SEUL = /^\s*(select|with)\s/i;
const INTERDIT = /\b(insert|update|delete|drop|create|alter|truncate|merge|grant|revoke|exec|execute|call)\b/i;

let pool = null;
let dialecteDetecte = null;

function chaineConnexion() {
  if (!DSN) return '';
  // Une chaîne complète contient déjà des paires clé=valeur.
  let c = DSN.includes('=') ? DSN : 'DSN=' + DSN + ';';
  if (UTILISATEUR && !/\bUID=|\bUser\s*ID=/i.test(c)) c += 'UID=' + UTILISATEUR + ';';
  if (MOTDEPASSE && !/\bPWD=|\bPassword=/i.test(c)) c += 'PWD=' + MOTDEPASSE + ';';
  return c;
}

function disponible() {
  return Boolean(odbc && ACTIVE && DSN);
}

// Explique précisément pourquoi la base n'est pas joignable, pour le diagnostic.
function raisonIndisponible() {
  if (!odbc) return 'Le module npm « odbc » n\'est pas installé. Lancer : npm install odbc';
  if (!ACTIVE) return 'AVANTAGE_BD_ACTIVE n\'est pas à true dans .env — le bridge reste sur les exports CSV.';
  if (!DSN) return 'AVANTAGE_DSN n\'est pas défini dans .env.';
  return null;
}

async function obtenirPool() {
  if (!disponible()) throw new Error(raisonIndisponible());
  if (pool) return pool;
  pool = await odbc.pool({
    connectionString: chaineConnexion(),
    connectionTimeout: 15,
    loginTimeout: 15,
    initialSize: 1,
    maxSize: 4,
  });
  return pool;
}

// Exécute un SELECT. Refuse tout le reste.
async function interroger(sql, parametres) {
  if (!SELECT_SEUL.test(sql) || INTERDIT.test(sql)) {
    throw new Error('Requête refusée : la connexion Avantage est en lecture seule (SELECT uniquement).');
  }
  const p = await obtenirPool();
  const cx = await p.connect();
  try {
    return await cx.query(sql, parametres || []);
  } finally {
    await cx.close();
  }
}

// Détecte le moteur une fois, à partir de ce que le pilote déclare.
async function dialecte() {
  if (DIALECTE_CONFIG !== 'auto') return DIALECTE_CONFIG;
  if (dialecteDetecte) return dialecteDetecte;

  const c = chaineConnexion().toLowerCase();
  if (/pervasive|actian|zen|btrieve/.test(c)) dialecteDetecte = 'zen';
  else if (/sql server|sqlncli|msodbcsql/.test(c)) dialecteDetecte = 'mssql';
  else if (/sybase|sqlany|anywhere/.test(c)) dialecteDetecte = 'sybase';
  else dialecteDetecte = 'generique';
  return dialecteDetecte;
}

// Liste les tables visibles. Sert au diagnostic et à valider le mappage des colonnes.
async function listerTables() {
  const p = await obtenirPool();
  const cx = await p.connect();
  try {
    const res = await cx.tables(null, null, null, 'TABLE');
    return (res || []).map(t => ({
      catalogue: t.TABLE_CAT || t.TABLE_QUALIFIER || null,
      schema: t.TABLE_SCHEM || t.TABLE_OWNER || null,
      nom: t.TABLE_NAME,
      type: t.TABLE_TYPE,
    }));
  } finally {
    await cx.close();
  }
}

// Liste les colonnes d'une table, avec leur type. C'est la sortie à reporter dans
// src/config/colonnes-avantage.js.
async function listerColonnes(nomTable) {
  const p = await obtenirPool();
  const cx = await p.connect();
  try {
    const res = await cx.columns(null, null, nomTable, null);
    return (res || []).map(c => ({
      position: c.ORDINAL_POSITION,
      nom: c.COLUMN_NAME,
      type: c.TYPE_NAME,
      taille: c.COLUMN_SIZE,
    })).sort((a, b) => (a.position || 0) - (b.position || 0));
  } finally {
    await cx.close();
  }
}

async function fermer() {
  if (pool) { try { await pool.close(); } catch (e) {} pool = null; }
}

module.exports = {
  disponible, raisonIndisponible, interroger, dialecte,
  listerTables, listerColonnes, fermer, chaineConnexion,
};
