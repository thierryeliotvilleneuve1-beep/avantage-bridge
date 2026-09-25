// DIAGNOSTIC : cherche un MONTANT exact dans les tables candidates d'encaissement/dépôt d'Avantage,
// pour localiser où sont enregistrés les paiements clients. LECTURE SEULE, DBF (sans passerelle).
//
// Balaie chaque table, et pour chaque enregistrement teste tous les champs numériques : si l'un
// vaut ≈ le montant cherché, on rapporte la table, le champ, et les champs identifiants de la ligne.

const path = require('path');
const dbf = require('../db/lecteurDbf');

function repertoire() {
  if (process.env.AVANTAGE_DBF_DIR) return path.resolve(process.env.AVANTAGE_DBF_DIR);
  return process.platform === 'win32' ? 'A:\\AVA01' : '';
}
function num(v) { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : NaN; }

// Tables candidates par défaut : banque, dépôts, réceptions, comptes clients.
const TABLES_DEFAUT = ['BANQUE', 'DEPOT', 'CMRECU', 'RCVBIL', 'RCVDPA', 'RCVACM', 'CASHTX', 'CASHFL', 'BORDER', 'BORDERL'];

function chercher(montantCible, opts) {
  const tables = (opts && opts.tables) || TABLES_DEFAUT;
  const tol = (opts && opts.tolerance) || 0.02;
  const maxParTable = (opts && opts.maxParTable) || 20;
  const cible = num(montantCible);
  const resultats = [];
  const tablesLues = [];

  for (const table of tables) {
    const f = dbf.trouverFichier(repertoire(), table);
    if (!f) { tablesLues.push({ table, etat: 'absente' }); continue; }
    let meta;
    try { meta = dbf.lireEnTete(f); } catch (e) { tablesLues.push({ table, etat: 'illisible' }); continue; }
    const champsNum = meta.champs.filter(c => /[NFYB]/i.test(c.type)).map(c => c.nom);
    const champsTxt = meta.champs.map(c => c.nom).slice(0, 8); // identifiants pour contexte
    let trouves = 0;
    try {
      dbf.lireTable(f, { meta, filtre: (l) => {
        for (const ch of champsNum) {
          const v = num(l[ch]);
          if (Number.isFinite(v) && Math.abs(v - cible) <= tol) {
            const contexte = {};
            for (const t of champsTxt) contexte[t] = String(l[t] == null ? '' : l[t]).trim();
            if (trouves < maxParTable) resultats.push({ table, champ: ch, valeur: Math.round(v * 100) / 100, contexte });
            trouves++;
            break;
          }
        }
        return false;
      }});
    } catch (e) { tablesLues.push({ table, etat: 'erreur:' + e.message }); continue; }
    tablesLues.push({ table, etat: 'lue', correspondances: trouves });
  }
  return { ok: true, montant_cherche: cible, tables: tablesLues, correspondances: resultats };
}

module.exports = { chercher, repertoire };
