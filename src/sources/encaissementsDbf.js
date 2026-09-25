// Lit les ENCAISSEMENTS CLIENTS d'Avantage dans la table CMRECU (réceptions). LECTURE SEULE, DBF.
//
// CMRECU (structure kit) : CRNUM (n° client) · CRYEAR (année réf.) · CRDATE · CRMONTANT ·
//   CRNORECU (n° de reçu) · CRNUMORG (reçu original si amendé) · CRINIT (reçu original T/F) ·
//   CRACTIF (reçu actif T/F).
//
// NOTE : CMRECU est par CLIENT, pas par facture/projet — l'attribution à une facture précise se
// fait par rapprochement (montant/date) au niveau appelant. Ce module ne fait que lire.

const path = require('path');
const dbf = require('../db/lecteurDbf');

function repertoire() {
  if (process.env.AVANTAGE_DBF_DIR) return path.resolve(process.env.AVANTAGE_DBF_DIR);
  return process.platform === 'win32' ? 'A:\\AVA01' : '';
}
function resoudre(meta, prefixes) {
  const champs = meta.champs.map(c => ({ brut: c.nom, propre: c.nom.replace(/[^A-Za-z0-9]/g, '').toUpperCase() }));
  const map = {};
  for (const [logique, pref] of Object.entries(prefixes)) {
    const P = pref.toUpperCase();
    const hit = champs.find(c => c.propre === P) || champs.find(c => c.propre.startsWith(P));
    map[logique] = hit ? hit.brut : null;
  }
  return map;
}
function num(v) { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : 0; }
function r2(n) { return Math.round((n || 0) * 100) / 100; }
function txt(v) { return String(v == null ? '' : v).trim(); }
function vrai(v) { const s = txt(v).toUpperCase(); return s === 'T' || s === '.T.' || s === '1' || s === 'OUI' || s === 'Y'; }

function disponible() { return Boolean(dbf.trouverFichier(repertoire(), 'CMRECU')); }

// Encaissements d'un client (code exact, ex. « CONSEIL-MA »). actifsSeuls=true par défaut.
function lireParClient(clientCode, opts) {
  const actifsSeuls = !(opts && opts.actifsSeuls === false);
  const f = dbf.trouverFichier(repertoire(), 'CMRECU');
  if (!f) return { ok: false, raison: 'CMRECU introuvable' };
  const meta = dbf.lireEnTete(f);
  const c = resoudre(meta, { client: 'CRNUM', annee: 'CRYEAR', date: 'CRDATE', montant: 'CRMONTANT', norecu: 'CRNORECU', orig: 'CRNUMORG', init: 'CRINIT', actif: 'CRACTIF' });
  const cible = txt(clientCode).toUpperCase();
  const recus = [];
  dbf.lireTable(f, { meta, filtre: (l) => {
    if (txt(l[c.client]).toUpperCase() !== cible) return false;
    const actif = vrai(l[c.actif]);
    if (actifsSeuls && !actif) return false;
    recus.push({
      client: txt(l[c.client]), date: txt(l[c.date]), montant: r2(num(l[c.montant])),
      no_recu: txt(l[c.norecu]), no_original: txt(l[c.orig]), original: vrai(l[c.init]), actif,
    });
    return false;
  }});
  recus.sort((a, b) => a.date.localeCompare(b.date));
  const total = r2(recus.reduce((s, r) => s + r.montant, 0));
  return { ok: true, client: clientCode, nb: recus.length, total_encaisse: total, recus };
}

module.exports = { disponible, lireParClient, repertoire, resoudre };
