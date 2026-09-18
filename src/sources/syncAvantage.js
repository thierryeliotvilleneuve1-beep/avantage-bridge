// Prépare les données Avantage pour la synchronisation vers Manoeuvre.
//
// S'appuie sur donneesAvantage, qui lit la BASE .DBF en direct (A:\AVA01), avec repli
// automatique sur les exports CSV. Ce module ne fait que remettre en forme ce que
// donneesAvantage fournit, dans les structures attendues par le writer Base44.
//
// LECTURE SEULE côté Avantage — rien n'est jamais écrit dans la comptabilité.

const dav = require('./donneesAvantage');
const { normaliserProjet } = require('../parsers/parseGrandLivre');

// Résout les noms de colonnes .DBF une fois par démarrage. Sans mappage, les tables
// non nommées (PYBBIL, TRANS) retombent sur le CSV.
async function preparer(forcer) {
  try { return await dav.autoMapper(forcer); } catch (e) { return []; }
}

const { estLisibleEnBd } = require('../config/colonnes-avantage');
const depotDbf = require('./depotDbf');

// Noms de projets depuis CONTRA — uniquement si la table est lisible. Chiffree, on
// renvoie {} et les projets seront nommes par leur numero.
async function chargerNomsProjets() {
  try {
    if (depotDbf.disponible() && depotDbf.aTable('CONTRA') && !estLisibleEnBd('CONTRA')) return {};
    return await dav.chargerProjets();
  } catch (e) { return {}; }
}

// Factures client — SEULEMENT depuis FACTMA (ou son CSV). Jamais depuis le grand livre :
// dumper les comptes de produits comme des milliers de fausses factures est inutile et lent.
// FACTMA chiffree -> aucune facture (on le signale, on n'invente rien).
async function chargerFacturesLisibles() {
  try {
    if (depotDbf.disponible() && depotDbf.aTable('FACTMA') && !estLisibleEnBd('FACTMA')) {
      return { chiffree: true, factures: [] };
    }
    const brut = await dav.chargerRevenus();
    const prov = dav.provenance().revenus;
    if (prov && /TRANS|grand livre/i.test(prov.detail || '')) return { chiffree: true, factures: [] };
    const factures = brut.map(f => ({
      numero_facture: f.numeroFacture, numero_projet: f.numeroProjet, client_nom: f.client,
      date_facture: f.date, total_facture: f.montant, solde_ouvert: f.soldeOuvert,
      retenue_total: f.retenue, statut_paiement: f.soldeOuvert > 0 ? 'ouvert' : 'paye',
    })).filter(f => f.numero_facture);
    return { chiffree: false, factures };
  } catch (e) { return { chiffree: true, factures: [] }; }
}

// Transactions regroupées par numéro de projet normalisé.
// - PYBBIL : agrégé par facture (numéro de journal) → montant NET, taxes déjà exclues
//   par donneesAvantage. Une facture = une transaction, comme l'attend l'entité.
// - TRANS  : une transaction par écriture salariale (E) ou bancaire (B).
async function chargerTransactionsParProjet() {
  const charges = await dav.chargerCharges();
  const commandeDiv = await dav.chargerCommandeDivisions();

  const pybbil = new Map();   // clé journal|projet → accumulateur net
  const ecritures = [];

  for (const l of charges) {
    if (!l.estProjet || !l.numeroProjet) continue;
    if (l.typeTransaction === 'P') {
      const cle = l.numeroJournal + '|' + l.numeroProjet;
      let a = pybbil.get(cle);
      if (!a) { a = Object.assign({}, l, { montant: 0 }); pybbil.set(cle, a); }
      a.montant += l.montant;
    } else {
      ecritures.push(l);
    }
  }

  const parProjet = new Map();
  const ajouter = (projet, payload) => {
    if (!parProjet.has(projet)) parProjet.set(projet, []);
    parProjet.get(projet).push(payload);
  };

  for (const a of pybbil.values()) {
    const numCommande = a.numeroCommande ? String(a.numeroCommande).padStart(9, '0') : '';
    const codeDivision = numCommande ? (commandeDiv[numCommande] || '') : '';
    ajouter(a.numeroProjet, {
      code_division: codeDivision,
      date_transaction: a.date,
      numero_journal: a.numeroJournal,
      numero_facture: a.numeroFacture,
      fournisseur: a.fournisseur,
      description: a.description || a.numeroFacture,
      montant: Math.round(a.montant * 100) / 100,
      type_transaction: 'P',
      numero_gl: '33200',
      is_mo: false,
      numero_commande_avantage: numCommande,
    });
  }

  for (const l of ecritures) {
    ajouter(l.numeroProjet, {
      code_division: l.codeActivite || '',
      date_transaction: l.date,
      numero_journal: l.numeroJournal,
      numero_facture: '',
      fournisseur: l.fournisseur,
      description: l.description,
      montant: l.montant,
      type_transaction: l.typeTransaction,
      numero_gl: l.numeroGl,
      is_mo: !!l.estMo,
      numero_commande_avantage: '',
    });
  }

  // Un même numéro de journal peut porter plusieurs activités (une ligne chacune).
  // Sans clé distincte, chaque ligne écrase la précédente dans l'entité et le détail
  // de la main-d'oeuvre par division est perdu en silence.
  for (const rows of parProjet.values()) {
    const vus = new Map();
    for (const r of rows) {
      const base = r.numero_journal || 'SANS-JOURNAL';
      const n = (vus.get(base) || 0) + 1;
      vus.set(base, n);
      if (n > 1) r.numero_journal = base + '-' + (r.code_division || n);
    }
  }

  return parProjet;
}

// Transactions d'un seul projet, quel que soit le zéro-padding du code demandé.
function transactionsDe(parProjet, code) {
  const cible = normaliserProjet(String(code).replace(/^P/i, ''));
  if (parProjet.has(cible)) return parProjet.get(cible);
  // Repli : comparaison sur la partie numérique, sans le padding.
  const n = parseInt(cible, 10);
  for (const [k, v] of parProjet) {
    if (parseInt(k, 10) === n && k.indexOf('-') === -1) return v;
  }
  return [];
}

module.exports = { preparer, chargerNomsProjets, chargerFacturesLisibles, chargerTransactionsParProjet, transactionsDe, provenance: dav.provenance };
