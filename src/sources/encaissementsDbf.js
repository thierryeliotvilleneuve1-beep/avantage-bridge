// Lit les ENCAISSEMENTS CLIENTS d'Avantage. LECTURE SEULE, DBF (sans passerelle).
//
// CRC utilise le module A/R standard :
//   BANQUE  = dépôts bancaires (BTYP=1) : BCLI (client), BMNT (montant), BDAT (date), BNUM (n° dépôt).
//   RCVACM  = application des encaissements aux factures : RANOPAI (n° de compte/facture réglé),
//             RAMONT (montant appliqué), RASEQ (↔ BANQUE.BNUM), RADATE, RACREDIT, RARET (retenue).
//
// On lit les dépôts d'un client (BANQUE), puis les applications RCVACM rattachées à ces dépôts
// (via RASEQ), regroupées par RANOPAI = ce qui a été encaissé par facture/compte.

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

function disponible() { return Boolean(dbf.trouverFichier(repertoire(), 'BANQUE')); }

// Dépôts (encaissements) d'un client dans BANQUE (BTYP=1), + applications RCVACM rattachées.
function lireParClient(clientCode) {
  const cible = txt(clientCode).toUpperCase();
  const fB = dbf.trouverFichier(repertoire(), 'BANQUE');
  if (!fB) return { ok: false, raison: 'BANQUE introuvable' };
  const metaB = dbf.lireEnTete(fB);
  const cB = resoudre(metaB, { num: 'BNUM', date: 'BDAT', type: 'BTYP', glb: 'BGLB', nom: 'BNOM', client: 'BCLI', montant: 'BMNT' });

  const depots = [];
  const parNum = new Map(); // BNUM -> dépôt
  dbf.lireTable(fB, { meta: metaB, filtre: (l) => {
    if (txt(l[cB.client]).toUpperCase() !== cible) return false;
    if (txt(l[cB.type]) !== '1') return false; // 1 = dépôt (encaissement)
    const d = { no_depot: txt(l[cB.num]), date: txt(l[cB.date]), montant: r2(num(l[cB.montant])), note: txt(l[cB.nom]) };
    depots.push(d); parNum.set(d.no_depot, d);
    return false;
  }});

  // Applications RCVACM rattachées à ces dépôts (RASEQ ↔ BNUM), regroupées par facture (RANOPAI).
  const applications = [];
  const parFacture = new Map();
  const fR = dbf.trouverFichier(repertoire(), 'RCVACM');
  if (fR) {
    const metaR = dbf.lireEnTete(fR);
    const cR = resoudre(metaR, { nopai: 'RANOPAI', date: 'RADATE', montant: 'RAMONT', credit: 'RACREDIT', seq: 'RASEQ', ret: 'RARET' });
    dbf.lireTable(fR, { meta: metaR, filtre: (l) => {
      const seq = txt(l[cR.seq]);
      if (!parNum.has(seq)) return false; // ne garder que les applications de CE client
      const ranopai = txt(l[cR.nopai]);
      const facture = ranopai.split('-')[0]; // « 006062-01 » -> compte/facture « 006062 »
      const montant = r2(num(l[cR.montant]));
      applications.push({ facture, ranopai, date: txt(l[cR.date]), montant, no_depot: seq });
      parFacture.set(facture, r2((parFacture.get(facture) || 0) + montant));
      return false;
    }});
  }

  depots.sort((a, b) => a.date.localeCompare(b.date));
  const total_encaisse = r2(depots.reduce((s, d) => s + d.montant, 0));
  const par_facture = [...parFacture.entries()].map(([facture, encaisse]) => ({ facture, encaisse })).sort((a, b) => a.facture.localeCompare(b.facture));
  return { ok: true, client: clientCode, nb_depots: depots.length, total_encaisse, depots, par_facture, applications };
}

module.exports = { disponible, lireParClient, repertoire, resoudre };
