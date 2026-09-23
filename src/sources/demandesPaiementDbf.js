// Lit les demandes de paiement d'Avantage dans la table CONFIT (LECTURE SEULE).
//
// CONFIT est la « facturation de projet » d'Avantage : une ligne par contrat + division
// portant l'état de la DERNIÈRE demande de paiement. Le bridge la RECOPIE telle quelle —
// aucun calcul métier ; les seuls dérivés (% cumulatif) sont l'arithmétique qu'Avantage
// affiche lui-même.
//
// Colonnes CONFIT (décodées et validées sur données réelles) :
//   CICONT   n° de contrat/projet
//   CIANUM   division (activité)
//   CIREV    prix contractuel de la division (« dernière DP » = inclut les changements approuvés)
//   CIANTMNT montant cumulatif ANTÉRIEUR (DP précédentes)
//   CICUMMNT montant cumulatif À DATE  (= CIANTMNT + CIMNT)
//   CIMNT    montant de CETTE DP       (= CIREV × CIPRC)
//   CIPRC    fraction facturée cette DP (0,1 = 10 %)
//
// Ce que CONFIT ne contient PAS : le n° de facture Avantage ni les dates (facturation
// client = FACTMA, chiffrée). L'en-tête est donc mirroré sans ces champs.

const path = require('path');
const dbf = require('../db/lecteurDbf');

function repertoire() {
  if (process.env.AVANTAGE_DBF_DIR) return path.resolve(process.env.AVANTAGE_DBF_DIR);
  return process.platform === 'win32' ? 'A:\\AVA01' : '';
}

// Résout un champ logique par préfixe sur un nom d'en-tête nettoyé (mêmes octets parasites
// que CONPRE/CONACT). Repris de budgetDbf.
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
function act(v) { return String(v == null ? '' : v).trim().replace(/\.00$/, ''); }
function projNum(v) { const a = parseInt(String(v == null ? '' : v).trim(), 10); return Number.isFinite(a) ? a : null; }
function r2(n) { return Math.round((n || 0) * 100) / 100; }

function disponible() { return Boolean(dbf.trouverFichier(repertoire(), 'CONFIT')); }

// Lit CONFIT en UN passage et regroupe par contrat → { <numContrat>: {divisions:[…], totaux} }.
// Chaque division est la recopie fidèle de la ligne CONFIT (une ligne par contrat+division).
function lireParProjet() {
  const f = dbf.trouverFichier(repertoire(), 'CONFIT');
  if (!f) return new Map();
  const meta = dbf.lireEnTete(f);
  const c = resoudre(meta, {
    contrat: 'CICONT', division: 'CIANUM', seq: 'CISEQ', prix: 'CIREV',
    anterieur: 'CIANTMNT', cumulatif: 'CICUMMNT', montant: 'CIMNT', pct: 'CIPRC',
  });

  const parContrat = new Map();
  dbf.lireTable(f, { meta, filtre: (l) => {
    const p = projNum(l[c.contrat]); if (p == null) return false;
    const div = act(l[c.division]); if (!div) return false;
    let g = parContrat.get(p);
    if (!g) { g = new Map(); parContrat.set(p, g); }
    // CONFIT porte UNE ligne par division ET par cycle de DP (seq). L'état COURANT d'une division
    // est la DP la plus récente : on garde la ligne au plus grand CISEQ (zéro-paddé → comparaison
    // texte). NE PAS additionner les cycles (sinon montants ×N cycles).
    const seq = String(l[c.seq] == null ? '' : l[c.seq]).trim();
    const d = g.get(div);
    if (!d || seq > d._seq) {
      g.set(div, {
        code_division: div, _seq: seq,
        prix_contractuel: num(l[c.prix]),
        montant_anterieur: num(l[c.anterieur]),
        montant_cumulatif: num(l[c.cumulatif]),
        montant_dp: num(l[c.montant]),
        pct_dp_frac: num(l[c.pct]),
      });
    }
    return false; // effet de bord : on n'accumule pas dans `sorties`
  }});

  // Mise en forme finale par projet.
  const out = new Map();
  for (const [contrat, g] of parContrat.entries()) {
    const divisions = [...g.values()].map(d => ({
      code_division: d.code_division,
      prix_contractuel: r2(d.prix_contractuel),
      montant_anterieur: r2(d.montant_anterieur),
      montant_cumulatif: r2(d.montant_cumulatif),
      montant_dp: r2(d.montant_dp),
      pourcentage_dp: r2(d.pct_dp_frac * 100),
      // % cumulatif = arithmétique affichée par Avantage (cumulatif / contractuel).
      pourcentage_cumulatif: d.prix_contractuel ? r2((d.montant_cumulatif / d.prix_contractuel) * 100) : 0,
    })).sort((a, b) => a.code_division.localeCompare(b.code_division));

    const totaux = divisions.reduce((s, d) => ({
      prix_contractuel: s.prix_contractuel + d.prix_contractuel,
      montant_anterieur: s.montant_anterieur + d.montant_anterieur,
      montant_cumulatif: s.montant_cumulatif + d.montant_cumulatif,
      montant_dp: s.montant_dp + d.montant_dp,
    }), { prix_contractuel: 0, montant_anterieur: 0, montant_cumulatif: 0, montant_dp: 0 });

    out.set(contrat, {
      contrat,
      divisions,
      montant_total: r2(totaux.montant_dp),          // réclamé cette DP
      montant_cumulatif: r2(totaux.montant_cumulatif), // facturé à date
      prix_contractuel: r2(totaux.prix_contractuel),
    });
  }
  return out;
}

// Renvoie la demande de paiement d'un seul projet (code avec ou sans « P »).
function lireProjet(codeRaw) {
  const code = parseInt(String(codeRaw).replace(/^P/i, '').trim(), 10);
  const tout = lireParProjet();
  return tout.get(code) || null;
}

// DIAGNOSTIC : lignes CONFIT BRUTES d'un projet (aucune agrégation). Sert à voir combien de
// lignes existent par division, leurs séquences (CISEQ) et types (CITYPE) — pour valider la
// correction du bug de sommation. LECTURE SEULE, via DBF (sans passerelle).
function lireBrut(codeRaw) {
  const code = parseInt(String(codeRaw).replace(/^P/i, '').trim(), 10);
  const f = dbf.trouverFichier(repertoire(), 'CONFIT');
  if (!f) return { ok: false, raison: 'CONFIT introuvable' };
  const meta = dbf.lireEnTete(f);
  const c = resoudre(meta, {
    contrat: 'CICONT', division: 'CIANUM', seq: 'CISEQ', type: 'CITYPE',
    prix: 'CIREV', anterieur: 'CIANTMNT', cumulatif: 'CICUMMNT', montant: 'CIMNT', pct: 'CIPRC',
  });
  const lignes = [];
  const parDivision = {};
  dbf.lireTable(f, { meta, filtre: (l) => {
    const p = projNum(l[c.contrat]); if (p !== code) return false;
    const div = act(l[c.division]); if (!div) return false;
    parDivision[div] = (parDivision[div] || 0) + 1;
    lignes.push({
      division: div,
      seq: String(l[c.seq] == null ? '' : l[c.seq]).trim(),
      type: String(l[c.type] == null ? '' : l[c.type]).trim(),
      prix_contractuel: r2(num(l[c.prix])),
      montant_anterieur: r2(num(l[c.anterieur])),
      montant_cumulatif: r2(num(l[c.cumulatif])),
      montant_dp: r2(num(l[c.montant])),
      pct: num(l[c.pct]),
    });
    return false;
  }});
  lignes.sort((a, b) => a.division.localeCompare(b.division) || a.seq.localeCompare(b.seq));
  const multi = Object.entries(parDivision).filter(([, n]) => n > 1).map(([d, n]) => ({ division: d, lignes: n }));
  return { ok: true, projet: code, total_lignes: lignes.length, divisions_distinctes: Object.keys(parDivision).length, divisions_multi_lignes: multi, lignes };
}

// DIAGNOSTIC : en-têtes de demandes de paiement d'un projet (table CONFAC). Chaque ligne = une
// DP numérotée réelle (CFNOD) avec sa date et son n° de facture (CFFACT). LECTURE SEULE via DBF.
function lireEntetes(codeRaw) {
  const code = parseInt(String(codeRaw).replace(/^P/i, '').trim(), 10);
  const f = dbf.trouverFichier(repertoire(), 'CONFAC');
  if (!f) return { ok: false, raison: 'CONFAC introuvable' };
  const meta = dbf.lireEnTete(f);
  const c = resoudre(meta, {
    contrat: 'CFCONT', numero: 'CFNOD', date: 'CFDATE', facture: 'CFFACT',
    date_facture: 'CFDATEF', seq: 'CFSEQ', date_prec: 'CFDATEC',
  });
  const entetes = [];
  dbf.lireTable(f, { meta, filtre: (l) => {
    const p = projNum(l[c.contrat]); if (p !== code) return false;
    entetes.push({
      numero_dp: String(l[c.numero] == null ? '' : l[c.numero]).trim(),
      date: String(l[c.date] == null ? '' : l[c.date]).trim(),
      numero_facture: String(l[c.facture] == null ? '' : l[c.facture]).trim(),
      date_facture: String(l[c.date_facture] == null ? '' : l[c.date_facture]).trim(),
      seq: String(l[c.seq] == null ? '' : l[c.seq]).trim(),
      date_precedente: String(l[c.date_prec] == null ? '' : l[c.date_prec]).trim(),
    });
    return false;
  }});
  entetes.sort((a, b) => a.seq.localeCompare(b.seq));
  return { ok: true, projet: code, nb_dp: entetes.length, entetes };
}

module.exports = { disponible, lireParProjet, lireProjet, lireBrut, lireEntetes, repertoire, resoudre };
