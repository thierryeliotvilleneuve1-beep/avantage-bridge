// Connexion ODBC en LECTURE SEULE à la base Avantage.
//
// Deux voies d'accès, choisies automatiquement :
//
//   1. PowerShell + System.Data.Odbc — présent d'office sur Windows, aucune compilation.
//      C'est la voie par défaut : elle marche sans installer quoi que ce soit.
//   2. Le module npm `odbc` — si quelqu'un l'a installé, on le préfère : il est plus rapide
//      sur de gros volumes. Mais il exige node-gyp et les Build Tools Visual Studio.
//
// Le moteur de base (Actian Zen, SQL Server, Sybase…) n'a pas à être connu : c'est le
// pilote ODBC installé qui s'en charge. Seul le DSN change.
//
// Configuration (.env) :
//   AVANTAGE_DSN=AVA01                 nom du DSN ODBC, ou chaîne de connexion complète
//   AVANTAGE_BD_UTILISATEUR=lecture    optionnel
//   AVANTAGE_BD_MOTDEPASSE=...         optionnel
//   AVANTAGE_BD_ACTIVE=true            garde-fou : sans ça, le bridge reste sur les CSV
//   AVANTAGE_BD_VOIE=auto              auto | powershell | natif
//
// SÉCURITÉ — la base Avantage est la comptabilité de production. Toute requête qui n'est
// pas un SELECT est refusée ici, avant d'atteindre le pilote.

const psOdbc = require('./odbcPowershell');

let odbcNatif = null;
try { odbcNatif = require('odbc'); } catch (e) { /* absent : on passera par PowerShell */ }

const DSN = process.env.AVANTAGE_DSN || '';
const UTILISATEUR = process.env.AVANTAGE_BD_UTILISATEUR || '';
const MOTDEPASSE = process.env.AVANTAGE_BD_MOTDEPASSE || '';
const ACTIVE = String(process.env.AVANTAGE_BD_ACTIVE || '').toLowerCase() === 'true';
const VOIE_DEMANDEE = (process.env.AVANTAGE_BD_VOIE || 'auto').toLowerCase();

// Seules ces formes sont autorisées. Tout le reste est rejeté.
const SELECT_SEUL = /^\s*(select|with)\s/i;
const INTERDIT = /\b(insert|update|delete|drop|create|alter|truncate|merge|grant|revoke|exec|execute|call)\b/i;

let poolNatif = null;

function chaineConnexion() {
  if (!DSN) return '';
  let c = DSN.includes('=') ? DSN : 'DSN=' + DSN + ';';
  if (UTILISATEUR && !/\bUID=|\bUser\s*ID=/i.test(c)) c += 'UID=' + UTILISATEUR + ';';
  if (MOTDEPASSE && !/\bPWD=|\bPassword=/i.test(c)) c += 'PWD=' + MOTDEPASSE + ';';
  return c;
}

// Quelle voie sera réellement empruntée.
function voie() {
  if (VOIE_DEMANDEE === 'natif') return odbcNatif ? 'natif' : null;
  if (VOIE_DEMANDEE === 'powershell') return psOdbc.disponible() ? 'powershell' : null;
  if (odbcNatif) return 'natif';
  if (psOdbc.disponible()) return 'powershell';
  return null;
}

function disponible() {
  return Boolean(ACTIVE && DSN && voie());
}

// Explique précisément ce qui manque, pour que le diagnostic soit actionnable.
function raisonIndisponible() {
  if (!ACTIVE) return 'AVANTAGE_BD_ACTIVE n\'est pas à true dans .env — le bridge reste sur les exports CSV.';
  if (!DSN) return 'AVANTAGE_DSN n\'est pas défini dans .env. Y mettre le nom du DSN ODBC d\'Avantage.';
  if (!voie()) {
    return process.platform === 'win32'
      ? 'Aucune voie d\'accès ODBC : PowerShell est introuvable et le module npm « odbc » n\'est pas installé.'
      : 'La lecture directe de la base n\'est possible que depuis le PC Windows qui héberge Avantage. '
        + 'Sur cette machine (' + process.platform + '), le bridge lit les exports CSV.';
  }
  return null;
}

function verifierLecture(sql) {
  if (!SELECT_SEUL.test(sql) || INTERDIT.test(sql)) {
    throw new Error('Requête refusée : la connexion Avantage est en lecture seule (SELECT uniquement).');
  }
}

async function poolOdbc() {
  if (poolNatif) return poolNatif;
  poolNatif = await odbcNatif.pool({
    connectionString: chaineConnexion(),
    connectionTimeout: 15,
    loginTimeout: 15,
    initialSize: 1,
    maxSize: 4,
  });
  return poolNatif;
}

// Exécute un SELECT. `limite` borne le nombre de lignes rapatriées (0 = sans limite).
async function interroger(sql, limite) {
  verifierLecture(sql);
  if (!disponible()) throw new Error(raisonIndisponible());

  if (voie() === 'natif') {
    const p = await poolOdbc();
    const cx = await p.connect();
    try {
      const res = await cx.query(sql);
      const arr = Array.from(res || []);
      return limite > 0 ? arr.slice(0, limite) : arr;
    } finally { await cx.close(); }
  }
  return psOdbc.interroger(chaineConnexion(), sql, limite || 0);
}

async function listerTables() {
  if (!disponible()) throw new Error(raisonIndisponible());
  if (voie() === 'natif') {
    const p = await poolOdbc();
    const cx = await p.connect();
    try {
      const res = await cx.tables(null, null, null, 'TABLE');
      return (res || []).map(t => ({
        catalogue: t.TABLE_CAT || t.TABLE_QUALIFIER || null,
        schema: t.TABLE_SCHEM || t.TABLE_OWNER || null,
        nom: t.TABLE_NAME, type: t.TABLE_TYPE,
      })).filter(t => t.nom);
    } finally { await cx.close(); }
  }
  return psOdbc.listerTables(chaineConnexion());
}

async function listerColonnes(nomTable) {
  if (!disponible()) throw new Error(raisonIndisponible());
  if (voie() === 'natif') {
    const p = await poolOdbc();
    const cx = await p.connect();
    try {
      const res = await cx.columns(null, null, nomTable, null);
      return (res || []).map(c => ({
        position: Number(c.ORDINAL_POSITION || 0), nom: c.COLUMN_NAME,
        type: c.TYPE_NAME, taille: c.COLUMN_SIZE,
      })).filter(c => c.nom).sort((a, b) => a.position - b.position);
    } finally { await cx.close(); }
  }
  return psOdbc.listerColonnes(chaineConnexion(), nomTable);
}

// Échantillonne une table pour valider un mappage. La syntaxe de limitation varie d'un
// moteur à l'autre : on essaie les formes courantes plutôt que d'exiger un dialecte.
async function echantillonner(nomTable, n) {
  const taille = n || 300;
  const formes = [
    'SELECT TOP ' + taille + ' * FROM ' + nomTable,   // SQL Server, Sybase, Actian Zen
    'SELECT * FROM ' + nomTable + ' FETCH FIRST ' + taille + ' ROWS ONLY',
    'SELECT * FROM ' + nomTable + ' LIMIT ' + taille, // MySQL, PostgreSQL, Firebird
    'SELECT * FROM ' + nomTable,                      // dernier recours : borné côté client
  ];
  let derniere = null;
  for (const sql of formes) {
    try {
      const lignes = await interroger(sql, taille);
      if (lignes && lignes.length) return lignes;
    } catch (e) { derniere = e; }
  }
  throw new Error('aucune forme de requête acceptée par le pilote' + (derniere ? ' (' + derniere.message + ')' : ''));
}

async function fermer() {
  if (poolNatif) { try { await poolNatif.close(); } catch (e) {} poolNatif = null; }
}

module.exports = {
  disponible, raisonIndisponible, voie, interroger,
  listerTables, listerColonnes, echantillonner, fermer, chaineConnexion,
  SELECT_SEUL, INTERDIT,
};
