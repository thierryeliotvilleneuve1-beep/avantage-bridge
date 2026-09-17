const path = require('path');

const EXPORT_DIR = process.env.EXPORT_DIR
  ? path.resolve(process.env.EXPORT_DIR)
  : path.resolve(__dirname, '../exports-avantage');

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  API_KEY: process.env.API_KEY || 'CHANGE_MOI_CLE_SECRETE_LONGUE',
  EXPORT_DIR,
  XLSX_PATH: path.join(EXPORT_DIR, 'export.xlsx'),
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '*/15 * * * *',
  // Sync complet (budget + BC + transactions) sur tous les projets actifs.
  FULL_SYNC_ON_CRON: process.env.FULL_SYNC_ON_CRON !== 'false',
  // Liste blanche de codes projet ('auto' = tous les projets actifs de Manoeuvre).
  SYNC_PROJETS: (process.env.SYNC_PROJETS || 'auto').trim(),
  // Au-dela de ce delai, l'export Avantage est considere perime.
  MAX_EXPORT_AGE_HOURS: parseFloat(process.env.MAX_EXPORT_AGE_HOURS) || 24,
  // Relance un sync des qu'un nouvel export.xlsx est depose.
  WATCH_EXPORT: process.env.WATCH_EXPORT !== 'false',
  // Source des donnees Avantage: 'odbc' (lecture directe de la BD),
  // 'xlsx' (export Excel), 'auto' (odbc des qu'un DSN est configure).
  AVANTAGE_SOURCE: (process.env.AVANTAGE_SOURCE || 'auto').trim(),
  // Repli sur l'export Excel si la BD est injoignable.
  FALLBACK_XLSX: process.env.FALLBACK_XLSX !== 'false',
  // Saute les projets dont aucune donnee Avantage n'a change depuis le dernier sync.
  SKIP_UNCHANGED: process.env.SKIP_UNCHANGED !== 'false',
  STATE_FILE: require('path').resolve(__dirname, '../.sync-state.json'),
  VERSION: '7.2.0',
};
