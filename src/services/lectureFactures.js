// Lecture des FACTURES CLIENT d'un projet depuis FACTMA d'Avantage, via la passerelle SDK
// (op R09, index FFCONT = factures par contrat). LECTURE SEULE.
//
// FACTMA était chiffrée → le n° de facture et la date manquaient dans Manœuvre. Le SDK les
// débloque. Sortie alignée sur l'entité FactureClient (writeFactures) : numero_facture,
// numero_projet, client_nom, date_facture, total_facture, solde_ouvert, statut_paiement.
//
// FACTMA (structure kit SDK, validée sur données réelles) :
//   [0] FFCNUM (n° client)  [1] FFCNOM (nom client)  [17] FFSS_TAX (sous-total HT)
//   [21] FFSOLDE (solde)  [22] FFTOTDU (total à payer)  [24] FFNOFACT (n° facture)
//   [25] FFDATE (date facture)  [26] FFCREDIT (note de crédit T/F)
//   [62] FFPRCRET (% retenue)  [67] FFMNTRET (retenue HT)  [68] FFTOTRET (retenue totale)
//   [82] FFNOREF (n° de compte ouvert = clé de rapprochement avec les encaissements)
//
// PAIEMENTS CLIENTS : FFSOLDE ne reflète PAS les encaissements clients (validé sur données réelles).
// Le vrai « payé » se lit dans le grand livre A/R (BANQUE + RCVACM, cf. encaissementsDbf) : chaque
// application RCVACM.RANOPAI (« 006062-01 ») pointe le compte ouvert « 006062 » = FACTMA.FFNOREF.
// On rapproche donc encaissé[client|FFNOREF] pour obtenir montant_paye et le vrai solde.

const { interroger, parseCsv, actif } = require('./maintcpClient');
const encaissements = require('../sources/encaissementsDbf');

const FF_CNUM = parseInt(process.env.AVANTAGE_SDK_COL_FF_CNUM, 10) || 0;
const FF_CNOM = parseInt(process.env.AVANTAGE_SDK_COL_FF_CNOM, 10) || 1;
const FF_SSTAX = parseInt(process.env.AVANTAGE_SDK_COL_FF_SSTAX, 10) || 17;
const FF_TAXF = parseInt(process.env.AVANTAGE_SDK_COL_FF_TAXF, 10) || 18;  // FFTAXF : TPS (fédéral)
const FF_TAXP = parseInt(process.env.AVANTAGE_SDK_COL_FF_TAXP, 10) || 19;  // FFTAXP : TVQ (provincial)
const FF_SOLDE = parseInt(process.env.AVANTAGE_SDK_COL_FF_SOLDE, 10) || 21;
const FF_TOTDU = parseInt(process.env.AVANTAGE_SDK_COL_FF_TOTDU, 10) || 22;
const FF_NOFACT = parseInt(process.env.AVANTAGE_SDK_COL_FF_NOFACT, 10) || 24;
const FF_DATE = parseInt(process.env.AVANTAGE_SDK_COL_FF_DATE, 10) || 25;
const FF_CREDIT = parseInt(process.env.AVANTAGE_SDK_COL_FF_CREDIT, 10) || 26;
const FF_PRCRET = parseInt(process.env.AVANTAGE_SDK_COL_FF_PRCRET, 10) || 62;
const FF_MNTRET = parseInt(process.env.AVANTAGE_SDK_COL_FF_MNTRET, 10) || 67;
const FF_TOTRET = parseInt(process.env.AVANTAGE_SDK_COL_FF_TOTRET, 10) || 68;
const FF_NOREF = parseInt(process.env.AVANTAGE_SDK_COL_FF_NOREF, 10) || 82;

function nombre(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Clé de rapprochement d'un n° de compte : chiffres seuls, zéros de tête ôtés (« 006062 » → « 6062 »),
// pour que FFNOREF et la base RANOPAI se comparent quel que soit le zéro-paddage de chaque table.
function cleCompte(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d ? String(parseInt(d, 10)) : '';
}
function r2(n) { return Math.round((n || 0) * 100) / 100; }

// Construit la carte encaissé[<client>|<cleCompte>] pour les clients présents dans `factures`.
// Ne lit le grand livre que si disponible (Windows/A:\) — sinon renvoie null (repli sur FFSOLDE).
function chargerEncaissements(factures) {
  if (!encaissements.disponible()) return null;
  const carte = new Map();
  const clientsOk = new Set();
  const clients = [...new Set(factures.map(f => f.client).filter(Boolean))];
  for (const cli of clients) {
    let rec;
    try { rec = encaissements.lireParClient(cli); } catch (_) { rec = null; }
    if (!rec || !rec.ok) continue;
    clientsOk.add(String(cli).toUpperCase());
    for (const pf of rec.par_facture || []) {
      carte.set(String(cli).toUpperCase() + '|' + cleCompte(pf.facture), r2(pf.encaisse));
    }
  }
  return { carte, clientsOk };
}

// Statut de paiement (libellé lisible) déduit du payé réel et de la retenue contractuelle.
function libelleStatut({ credit, paye, solde_reel, retenue_total }) {
  if (credit) return 'Note de crédit';
  if (paye <= 0.01) return 'Ouverte';
  if (solde_reel <= 0.01) return 'Payée';
  if (retenue_total > 0.01 && Math.abs(solde_reel - retenue_total) < 0.01) return 'Retenue';
  return 'Partielle';
}

// Lit les factures client d'un projet (FACTMA via R09, index FFCONT).
// `code` = n° de projet (avec/sans P) ; zéro-paddé à 10 chiffres pour l'index.
async function lireFactures(code) {
  if (!actif()) return { ok: false, raison: 'AVANTAGE_SDK_ACTIF≠true ou identifiants absents' };
  const conum = String(code).replace(/^P/i, '').trim().padStart(10, '0');
  const numero_projet = String(parseInt(conum, 10));
  const r = await interroger({ op: 'R09', mnemonique: 'FACTMA', index: 'FFCONT', valeur: conum });
  if (!r.ok) return { ok: false, erreur: r.erreur, requete: r.requete };

  const factures = [];
  for (const ligne of r.lignes) {
    const c = parseCsv(ligne);
    const numero = String(c[FF_NOFACT] || '').trim();
    if (!numero) continue;
    const credit = String(c[FF_CREDIT] || '').trim().toUpperCase() === 'T';
    const total = nombre(c[FF_TOTDU]);
    factures.push({
      numero_facture: numero,
      numero_projet,
      client: String(c[FF_CNUM] || '').trim(),
      client_nom: String(c[FF_CNOM] || '').trim(),
      numero_compte: String(c[FF_NOREF] || '').trim(),   // FFNOREF : clé de rapprochement A/R
      date_facture: String(c[FF_DATE] || '').trim(),
      sous_total_ht: nombre(c[FF_SSTAX]),
      montant_tps: nombre(c[FF_TAXF]),   // fédéral
      montant_tvq: nombre(c[FF_TAXP]),   // provincial
      total_facture: total,
      solde_avantage: nombre(c[FF_SOLDE]),   // FFSOLDE brut (NE reflète PAS les paiements clients)
      retenue_total: nombre(c[FF_TOTRET]),   // FFTOTRET : retenue totale (avec taxes)
      retenue_ht: nombre(c[FF_MNTRET]),      // FFMNTRET : retenue sans taxe
      retenue_pct: Math.round(nombre(c[FF_PRCRET]) * 10000) / 100, // FFPRCRET : ex. 0,10 → 10 %
      note_credit: credit,
    });
  }

  // Rapprochement des encaissements clients (grand livre A/R) sur FFNOREF.
  const enc = chargerEncaissements(factures);
  let total_facture = 0, total_solde = 0, total_paye = 0;
  for (const f of factures) {
    const cliKey = String(f.client).toUpperCase();
    const dispoClient = enc && enc.clientsOk.has(cliKey);
    // Payé réel = somme des applications RCVACM du compte ouvert (FFNOREF) de ce client.
    const paye = dispoClient ? (enc.carte.get(cliKey + '|' + cleCompte(f.numero_compte)) || 0) : 0;
    // Solde réel = total dû − encaissé. Sans grand livre lisible, repli sur FFSOLDE brut.
    const solde_reel = dispoClient ? r2(f.total_facture - paye) : f.solde_avantage;
    f.montant_paye = r2(paye);
    f.solde_ouvert = solde_reel;
    f.encaissement_rapproche = dispoClient;
    f.statut_paiement = libelleStatut({ credit: f.note_credit, paye: f.montant_paye, solde_reel, retenue_total: f.retenue_total });
    total_facture += f.total_facture;
    total_solde += solde_reel;
    total_paye += f.montant_paye;
  }

  factures.sort((a, b) => a.date_facture.localeCompare(b.date_facture) || a.numero_facture.localeCompare(b.numero_facture));
  return {
    ok: true, conum, numero_projet, nb_factures: r.count,
    encaissements_rapproches: Boolean(enc),
    total_facture: r2(total_facture),
    total_paye: r2(total_paye),
    solde_ouvert: r2(total_solde),
    factures,
  };
}

module.exports = { lireFactures, actif };
