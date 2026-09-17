const crypto = require('crypto');
const fs = require('fs');
const cfg = require('../config');
const { rowsFor } = require('./dataset');

function hash(v) { return crypto.createHash('md5').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex'); }

// Empreinte des donnees Avantage d'un projet. Si elle n'a pas bouge, rien a
// repousser: on evite des milliers d'appels Base44 inutiles a chaque cycle.
function fingerprint(code, ds) {
  const h = crypto.createHash('md5');
  for (const src of ['budget', 'facturation', 'transactions', 'facturesFournisseur', 'commandes']) {
    const rows = rowsFor(ds.index[src], code);
    h.update(src + ':' + rows.length + ';');
    for (const r of rows) h.update(JSON.stringify(r));
  }
  return h.digest('hex');
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(cfg.STATE_FILE, 'utf8')); } catch (e) { return { projets: {} }; }
}

function saveState(st) {
  try { fs.writeFileSync(cfg.STATE_FILE, JSON.stringify(st, null, 2)); } catch (e) {
    console.error('[WARN] Ecriture .sync-state.json:', e.message);
  }
}

module.exports = { fingerprint, hash, loadState, saveState };
