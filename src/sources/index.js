// Selection de la source Avantage: lecture directe de la BD (odbc) ou export Excel (xlsx).
const cfg = require('../config');

const sources = {
  xlsx: require('./xlsx-source'),
  odbc: require('./odbc-source'),
};

// 'auto' privilegie la BD des qu'une connexion ODBC est configuree.
function choisir() {
  const s = (cfg.AVANTAGE_SOURCE || 'auto').toLowerCase();
  if (s === 'xlsx' || s === 'odbc') return s;
  return (process.env.ODBC_DSN || process.env.ODBC_CONNECTION_STRING) ? 'odbc' : 'xlsx';
}

// Execute fn sur la source choisie; bascule sur l'export Excel si la BD est
// injoignable, pour ne pas arreter net le sync sur une panne de driver.
async function avecSource(fn, etat) {
  const nom = choisir();
  try {
    const r = await fn(sources[nom]);
    if (etat) { etat.source = nom; etat.repli = null; }
    return r;
  } catch (e) {
    if (nom !== 'odbc' || !cfg.FALLBACK_XLSX) throw e;
    console.error('[WARN] Lecture BD Avantage impossible (' + e.message + ') — repli sur export.xlsx');
    const r = await fn(sources.xlsx);
    if (etat) { etat.source = 'xlsx'; etat.repli = e.message; }
    return r;
  }
}

module.exports = { sources, choisir, avecSource };
