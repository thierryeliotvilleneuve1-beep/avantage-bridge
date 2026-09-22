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

// ── Engagé ventilé PAR DIVISION (activité) ──────────────────────────────────
// Le montant d'un BC est porté par ses LIGNES (COMITE, champ COMACT = activité).
// On lit les lignes du projet (R09,COMITE,CMCNT), on regroupe COMSTOT par COMACT,
// et on distingue l'engagé « ouvert » (lignes rattachées à un BC dont COMSTA=0)
// grâce aux en-têtes COMMAN (COMNO → statut). LECTURE SEULE.
//
// COMITE (structure kit SDK) : [0] COMCNT (projet) … [10] COMSTOT (sous-total ligne)
//                              … [17] COMACT (activité) … [24] COMNO (n° commande)
const CI_CNT = parseInt(process.env.AVANTAGE_SDK_COL_CI_CNT, 10) || 0;
const CI_STOT = parseInt(process.env.AVANTAGE_SDK_COL_CI_STOT, 10) || 10;
const CI_ACT = parseInt(process.env.AVANTAGE_SDK_COL_CI_ACT, 10) || 17;
const CI_NO = parseInt(process.env.AVANTAGE_SDK_COL_CI_NO, 10) || 24;

async function lireEngageDivisions(code) {
  if (!actif()) return { ok: false, raison: 'AVANTAGE_SDK_ACTIF≠true ou identifiants absents' };
  const conum = String(code).replace(/^P/i, '').trim().padStart(10, '0');

  // 1) En-têtes COMMAN → statut ouvert/fermé par n° de commande.
  const hEnt = await interroger({ op: 'R09', mnemonique: 'COMMAN', index: 'COMCNT', valeur: conum });
  if (!hEnt.ok) return { ok: false, erreur: hEnt.erreur, requete: hEnt.requete, etape: 'COMMAN' };
  const ouvertParNo = new Map();
  for (const l of hEnt.lignes) {
    const c = parseCsv(l);
    ouvertParNo.set(String(c[COL_NO] || '').trim(), String(c[COL_STA] || '').trim() === '0');
  }

  // 2) Lignes COMITE → regroupement de COMSTOT par activité.
  const li = await interroger({ op: 'R09', mnemonique: 'COMITE', index: 'CMCNT', valeur: conum });
  if (!li.ok) return { ok: false, erreur: li.erreur, requete: li.requete, etape: 'COMITE' };

  const parDivision = new Map();
  let lignes_ignorees = 0;
  for (const l of li.lignes) {
    const c = parseCsv(l);
    const act = String(c[CI_ACT] || '').trim();
    const montant = nombre(c[CI_STOT]);
    if (!act || montant === 0) { lignes_ignorees++; continue; } // lignes produit sans activité/montant
    const no = String(c[CI_NO] || '').trim();
    const ouvert = ouvertParNo.get(no) !== false; // défaut : compté si statut inconnu
    if (!parDivision.has(act)) parDivision.set(act, { code_division: act, engage_ouvert: 0, engage_total: 0, nb_lignes: 0 });
    const d = parDivision.get(act);
    d.engage_total += montant;
    if (ouvert) d.engage_ouvert += montant;
    d.nb_lignes++;
  }

  const divisions = [...parDivision.values()].map(d => ({
    code_division: d.code_division,
    engage_ouvert: Math.round(d.engage_ouvert * 100) / 100,
    engage_total: Math.round(d.engage_total * 100) / 100,
    nb_lignes: d.nb_lignes,
  })).sort((a, b) => a.code_division.localeCompare(b.code_division));

  const total_ouvert = Math.round(divisions.reduce((s, d) => s + d.engage_ouvert, 0) * 100) / 100;
  const total_general = Math.round(divisions.reduce((s, d) => s + d.engage_total, 0) * 100) / 100;

  return { ok: true, conum, nb_bc: hEnt.count, nb_lignes: li.count, lignes_ignorees, total_ouvert, total_general, divisions };
}

module.exports = { lireEngage, lireEngageDivisions, actif };
