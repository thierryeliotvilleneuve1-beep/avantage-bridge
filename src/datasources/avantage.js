// Source de données Avantage — LA BASE DE DONNÉES EST LA SOURCE DE VÉRITÉ.
//
// Mode "db" (défaut dès que AVANTAGE_DSN est configuré) : lecture directe des
// tables Avantage via ODBC. Exemple .env :
//   AVANTAGE_DSN=DSN=AVANTAGE;UID=utilisateur;PWD=motdepasse
// (créer le DSN système 64 bits dans « Sources de données ODBC » de Windows,
// pointé sur la base Avantage — ex. driver Actian/Pervasive ou celui fourni
// avec Avantage.)
//
// Mode "csv" : repli sur les exports exports-avantage/*.csv, utilisé
// uniquement si AVANTAGE_DSN est absent (ou DATA_SOURCE=csv forcé).
//
// Chaque table est retournée sous deux formes pour couvrir les deux styles de
// consommation du bridge :
//   objets  : lignes en objets clés par nom de colonne (CONUM, CPACT, ...)
//   lignes  : lignes en tableaux positionnels (même ordre que les colonnes)

const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const { parse } = require('csv-parse/sync');

const EXPORT_DIR = path.resolve(__dirname, '../../exports-avantage');
const DSN = process.env.AVANTAGE_DSN || '';
const SOURCE = (process.env.DATA_SOURCE || (DSN ? 'db' : 'csv')).toLowerCase();
const CSV_ENCODING = process.env.CSV_ENCODING || 'latin1';

// Tables connues du bridge — seule liste admise en SQL (pas d'injection possible).
const TABLES_VALIDES = /^[A-Z0-9_]{2,30}$/;

let pool = null;
async function getPool() {
  if (!pool) {
    // Require paresseux : le module natif odbc n'est chargé qu'en mode db,
    // le mode csv fonctionne sans lui.
    const odbc = require('odbc');
    pool = await odbc.pool({ connectionString: DSN, initialSize: 1, maxSize: 4 });
  }
  return pool;
}

function texte(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

async function lireDb(table) {
  if (!TABLES_VALIDES.test(table)) throw new Error('Nom de table invalide : ' + table);
  const p = await getPool();
  const result = await p.query('SELECT * FROM ' + table);
  const colonnes = (result.columns || []).map(c => c.name);
  const objets = result.map(r => {
    const o = {};
    colonnes.forEach(c => { o[c] = texte(r[c]); });
    return o;
  });
  const lignes = objets.map(o => colonnes.map(c => o[c]));
  return { source: 'db', table, colonnes, objets, lignes };
}

function vide(table, source) {
  return { source, table, colonnes: [], objets: [], lignes: [] };
}

function lireCsvFichier(table) {
  // COMMAN n'existe qu'en export.xlsx (export manuel Avantage) en mode csv.
  if (table === 'COMMAN') {
    const XLSX = require('xlsx');
    const xlsxPath = path.join(EXPORT_DIR, 'export.xlsx');
    if (!fs.existsSync(xlsxPath)) return vide(table, 'csv');
    const ws = XLSX.readFile(xlsxPath).Sheets['COMMAN'];
    if (!ws) return vide(table, 'csv');
    const objets = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const colonnes = objets.length ? Object.keys(objets[0]) : [];
    const lignes = objets.map(o => colonnes.map(c => texte(o[c])));
    return { source: 'csv', table, colonnes, objets, lignes };
  }
  const fichier = path.join(EXPORT_DIR, table + '.csv');
  if (!fs.existsSync(fichier)) return vide(table, 'csv');
  const contenu = iconv.decode(fs.readFileSync(fichier), CSV_ENCODING);
  const objets = parse(contenu, { columns: true, skip_empty_lines: true, trim: true });
  const lignes = parse(contenu, { columns: false, skip_empty_lines: true, trim: true, from_line: 2 });
  const colonnes = objets.length ? Object.keys(objets[0]) : [];
  return { source: 'csv', table, colonnes, objets, lignes };
}

async function lireTable(table) {
  if (SOURCE === 'db') return lireDb(table);
  return lireCsvFichier(table);
}

module.exports = { lireTable, SOURCE, DB_CONFIGUREE: !!DSN, EXPORT_DIR };
