// Lecture de l'ENGAGÉ RÉEL d'un projet depuis COMMAN (bons de commande fournisseurs) d'Avantage,
// via la passerelle SDK en op R09 (lecteur universel de table par nom). LECTURE SEULE.
//
// R09 = lit n'importe quelle table Avantage par son nom de fichier + index + valeur.
// Découvert le 2026-09-22 (voir vault 06-Skills/Bridge-Avantage-Manoeuvre/SDK-Avantage-maintcp-Protocole.md).
//
// COMMAN (structure kit SDK, ordre confirmé sur données réelles) :
//   [0] COMNO (n° commande)  [1] COMFRN (fournisseur)  [2] COMDATE  [3] COMLIVRE (livraison)
//   [4] COMSTOT (sous-total, HT)  [5] COMTXP (TVQ)  [6] COMTXF (TPS)  [7] COMTOT (total TTC)
//   [8] COMCLI  ...  [11] COMSEQ  [12] COMCNT (n° projet)  [13] COMSTA (0=ouvert, 1=fermé)

const { interroger, parseCsv, actif } = require('./maintcpClient');

const COL_NO = parseInt(process.env.AVANTAGE_SDK_COL_COMNO, 10) || 0;
const COL_FRN = parseInt(process.env.AVANTAGE_SDK_COL_COMFRN, 10) || 1;
const COL_DATE = parseInt(process.env.AVANTAGE_SDK_COL_COMDATE, 10) || 2;
const COL_STOT = parseInt(process.env.AVANTAGE_SDK_COL_COMSTOT, 10) || 4;
const COL_TOT = parseInt(process.env.AVANTAGE_SDK_COL_COMTOT, 10) || 7;
const COL_STA = parseInt(process.env.AVANTAGE_SDK_COL_COMSTA, 10) || 13;

function nombre(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Lit les bons de commande d'un projet (COMMAN via R09, index COMCNT) et calcule l'engagé.
// `code` = n° de projet (avec ou sans préfixe P) ; zéro-paddé à 10 chiffres pour l'index.
async function lireEngage(code) {
  if (!actif()) return { ok: false, raison: 'AVANTAGE_SDK_ACTIF≠true ou identifiants absents' };
  const conum = String(code).replace(/^P/i, '').trim().padStart(10, '0');
  const r = await interroger({ op: 'R09', mnemonique: 'COMMAN', index: 'COMCNT', valeur: conum });
  if (!r.ok) return { ok: false, erreur: r.erreur, requete: r.requete };

  const commandes = [];
  let engage_ouvert = 0, engage_total = 0;
  for (const ligne of r.lignes) {
    const c = parseCsv(ligne);
    const sousTotal = nombre(c[COL_STOT]);
    const ouvert = String(c[COL_STA] || '').trim() === '0';
    engage_total += sousTotal;
    if (ouvert) engage_ouvert += sousTotal;
    commandes.push({
      no: String(c[COL_NO] || '').trim(),
      fournisseur: String(c[COL_FRN] || '').trim(),
      date: String(c[COL_DATE] || '').trim(),
      sous_total: sousTotal,
      total: nombre(c[COL_TOT]),
      ouvert,
    });
  }
  return {
    ok: true,
    conum,
    nb_commandes: r.count,
    engage_ouvert: Math.round(engage_ouvert * 100) / 100,   // BC non soldés → engagé « vivant »
    engage_total: Math.round(engage_total * 100) / 100,     // toutes commandes
    commandes,
  };
}

module.exports = { lireEngage, actif };
