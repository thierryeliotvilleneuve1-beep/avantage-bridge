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

const { interroger, parseCsv, actif } = require('./maintcpClient');

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

function nombre(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
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
  let total_facture = 0, total_solde = 0;
  for (const ligne of r.lignes) {
    const c = parseCsv(ligne);
    const numero = String(c[FF_NOFACT] || '').trim();
    if (!numero) continue;
    const credit = String(c[FF_CREDIT] || '').trim().toUpperCase() === 'T';
    const total = nombre(c[FF_TOTDU]);
    const solde = nombre(c[FF_SOLDE]);
    total_facture += total;
    total_solde += solde;
    factures.push({
      numero_facture: numero,
      numero_projet,
      client: String(c[FF_CNUM] || '').trim(),
      client_nom: String(c[FF_CNOM] || '').trim(),
      date_facture: String(c[FF_DATE] || '').trim(),
      sous_total_ht: nombre(c[FF_SSTAX]),
      montant_tps: nombre(c[FF_TAXF]),   // fédéral
      montant_tvq: nombre(c[FF_TAXP]),   // provincial
      total_facture: total,
      solde_ouvert: solde,
      retenue_total: nombre(c[FF_TOTRET]),   // FFTOTRET : retenue totale (avec taxes)
      retenue_ht: nombre(c[FF_MNTRET]),      // FFMNTRET : retenue sans taxe
      retenue_pct: Math.round(nombre(c[FF_PRCRET]) * 10000) / 100, // FFPRCRET : ex. 0,10 → 10 %
      note_credit: credit,
      statut_paiement: credit ? 'Note de crédit' : (Math.abs(solde) < 0.01 ? 'Payée' : 'Ouverte'),
    });
  }
  factures.sort((a, b) => a.date_facture.localeCompare(b.date_facture) || a.numero_facture.localeCompare(b.numero_facture));
  return {
    ok: true, conum, numero_projet, nb_factures: r.count,
    total_facture: Math.round(total_facture * 100) / 100,
    solde_ouvert: Math.round(total_solde * 100) / 100,
    factures,
  };
}

module.exports = { lireFactures, actif };
