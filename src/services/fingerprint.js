const crypto = require('crypto');
const fs = require('fs');
const cfg = require('../config');
const { rowsFor } = require('./dataset');

// Empreinte des donnees Avantage d'un projet. Si elle n'a pas bouge, rien a
// repousser: on evite des milliers d'appels Base44 inutiles a chaque cron.
function fingerprint(code, ds) {
  const h = crypto.createHash('md5');
  for (const src of ['conpre', 'conact', 'trans', 'pybbil', 'comman']) {
    const rows = rowsFor(ds.index[src], code);
    h.update(src + ':' + rows.length + ';');
    for (const r of rows) h.update(JSON.stringify(r));
  }
  return h.digest('hex');
}

// Empreinte d'un fichier d'export complet (CONTRA, FACTMA...).
function fileFingerprint(filePath) {
  try { return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex'); }
  catch (e) { return null; }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(cfg.STATE_FILE, 'utf8')); } catch (e) { return { projets: {} }; }
}

function saveState(st) {
  try { fs.writeFileSync(cfg.STATE_FILE, JSON.stringify(st, null, 2)); } catch (e) {
    console.error('[WARN] Ecriture .sync-state.json:', e.message);
  }
}

module.exports = { fingerprint, fileFingerprint, loadState, saveState };
