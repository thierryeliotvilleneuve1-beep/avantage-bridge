// Lecture des tables Avantage directement dans les fichiers .DBF.
//
// C'est la source la plus fiable : les .DBF sont la base elle-même, toujours à jour, et ils
// déclarent leurs noms de champs dans leur en-tête. Aucun export à relancer, aucun pilote
// ODBC, aucun DSN.
//
// LECTURE SEULE — les fichiers sont ouverts en lecture et jamais modifiés.
//
// Le répertoire par défaut est A:\AVA01, surchargeable par AVANTAGE_DBF_DIR.

const fs = require('fs');
const path = require('path');
const dbf = require('../db/lecteurDbf');
const gl = require('../parsers/parseGrandLivre');
const { TABLES } = require('../config/colonnes-avantage');

const TABLES_ATTENDUES = ['PYBBIL', 'TRANS', 'FACTMA', 'CONTRA', 'ACTIVE', 'COMITE'];

function repertoire() {
  if (process.env.AVANTAGE_DBF_DIR) return path.resolve(process.env.AVANTAGE_DBF_DIR);
  return process.platform === 'win32' ? 'A:\\AVA01' : '';
}

function disponible() {
  const d = repertoire();
  return Boolean(d && fs.existsSync(d));
}

function raisonIndisponible() {
  const d = repertoire();
  if (!d) return 'AVANTAGE_DBF_DIR n\'est pas défini et A:\\AVA01 n\'existe que sous Windows.';
  if (!fs.existsSync(d)) return 'Le répertoire ' + d + ' est introuvable.';
  return null;
}

function fichier(table) {
  return dbf.trouverFichier(repertoire(), table);
}

function aTable(table) {
  return Boolean(fichier(table));
}

// Cache des en-têtes : relire l'en-tête à chaque appel serait inutile.
const enTetes = {};
function meta(table) {
  const f = fichier(table);
  if (!f) throw new Error('table ' + table + ' introuvable dans ' + repertoire());
  const st = fs.statSync(f);
  const cle = f + '|' + st.mtimeMs;
  if (!enTetes[cle]) enTetes[cle] = dbf.lireEnTete(f);
  return enTetes[cle];
}

// ── Interface attendue par autoMappage.deduire ───────────────────────────────────
async function listerColonnes(table) {
  return meta(table).champs.map((c, i) => ({
    position: i + 1, nom: c.nom, type: c.type, taille: c.longueur,
  }));
}

// Échantillon réparti sur toute la table : la tête de PYBBIL ne contient que des
// enregistrements de 2003, non représentatifs.
async function echantillonner(table, n) {
  return dbf.echantillonReparti(fichier(table), n || 300, meta(table));
}

// ── Lectures de haut niveau, alignées sur la sortie des parsers CSV ─────────────
// On lit avec un filtre de période : PYBBIL compte des centaines de milliers
// d'enregistrements et on ne veut pas les matérialiser tous.

function champ(table, logique) {
  const c = TABLES[table] && TABLES[table].colonnes[logique];
  return c && c.bd ? c.bd : null;
}

function dansPeriode(date, debut, fin) {
  if (!date) return false;
  if (debut && date < debut) return false;
  if (fin && date > fin) return false;
  return true;
}

function lireFactures(debut, fin) {
  const c = {
    numeroFacture: champ('FACTMA', 'numeroFacture'), numeroProjet: champ('FACTMA', 'numeroProjet'),
    client: champ('FACTMA', 'client'), date: champ('FACTMA', 'date'),
    montant: champ('FACTMA', 'montant'), soldeOuvert: champ('FACTMA', 'soldeOuvert'),
    retenue: champ('FACTMA', 'retenue'), noteCredit: champ('FACTMA', 'noteCredit'),
  };
  const lignes = dbf.lireTable(fichier('FACTMA'), {
    meta: meta('FACTMA'),
    filtre: l => dansPeriode(gl.normaliserDate(l[c.date]), debut, fin),
  });
  return lignes.map(l => {
    const brut = l[c.noteCredit];
    const credit = brut === true || /^(t|true|o|oui|vrai|1)$/i.test(String(brut === null ? '' : brut).trim());
    const signe = credit ? -1 : 1;
    return {
      numeroFacture: String(l[c.numeroFacture] || '').trim(),
      numeroProjet: gl.normaliserProjet(l[c.numeroProjet]),
      client: String(l[c.client] || '').trim(),
      date: gl.normaliserDate(l[c.date]),
      montant: signe * gl.nombre(l[c.montant]),
      soldeOuvert: signe * gl.nombre(l[c.soldeOuvert]),
      retenue: signe * gl.nombre(l[c.retenue]),
      noteCredit: credit,
    };
  }).filter(f => f.numeroFacture);
}

function lireChargesFournisseurs(debut, fin) {
  const c = {
    numeroSequence: champ('PYBBIL', 'numeroSequence'), date: champ('PYBBIL', 'date'),
    numeroFourn: champ('PYBBIL', 'numeroFourn'), numeroFacture: champ('PYBBIL', 'numeroFacture'),
    description: champ('PYBBIL', 'description'), montantTotal: champ('PYBBIL', 'montantTotal'),
    numeroProjet: champ('PYBBIL', 'numeroProjet'), numeroCommande: champ('PYBBIL', 'numeroCommande'),
    nomFournisseur: champ('PYBBIL', 'nomFournisseur'),
  };
  const paires = TABLES.PYBBIL.pairesGl.bd || [];
  const { GL_TAXES } = require('../config/plan-comptable');

  const sorties = [];
  dbf.lireTable(fichier('PYBBIL'), {
    meta: meta('PYBBIL'),
    filtre: l => {
      const date = gl.normaliserDate(l[c.date]);
      if (!dansPeriode(date, debut, fin)) return false;

      const numeroProjet = gl.normaliserProjet(l[c.numeroProjet]);
      const commun = {
        source: 'PYBBIL.DBF',
        numeroJournal: 'P' + String(l[c.numeroSequence] || '').trim(),
        date,
        numeroFacture: String(l[c.numeroFacture] || '').trim(),
        description: String(l[c.description] || '').trim(),
        fournisseur: String(l[c.nomFournisseur] || l[c.numeroFourn] || '').trim(),
        numeroProjet,
        estProjet: numeroProjet !== '',
        numeroCommande: String(l[c.numeroCommande] || '').trim(),
        typeTransaction: 'P',
      };

      let ajoutees = 0;
      for (const p of paires) {
        const g = String(l[p.gl] === null ? '' : l[p.gl]).trim();
        const m = gl.nombre(l[p.montant]);
        if (!g || GL_TAXES.includes(g) || !m) continue;
        sorties.push(Object.assign({}, commun, { numeroGl: g, montant: m }));
        ajoutees++;
      }
      if (!ajoutees) {
        const total = gl.nombre(l[c.montantTotal]);
        if (total) sorties.push(Object.assign({}, commun, { numeroGl: '', montant: total }));
      }
      return false; // on a déjà tout collecté, rien à conserver dans le résultat du lecteur
    },
  });
  return sorties;
}

// Journaux de TRANS retenus comme CHARGES, et pourquoi les autres sont écartés.
//
// TRANS est le grand livre de projet : il contient tout, y compris ce que d'autres tables
// contiennent déjà. Additionner sans trier gonflerait les coûts sans que rien ne le signale.
//
//   E  retenu  — écritures salariales. Aucune autre table ne les porte.
//   B  retenu  — transactions bancaires. Volume négligeable, mais rien ne les répète.
//   P  écarté  — contrepartie des factures fournisseurs, que PYBBIL porte déjà avec le nom
//                du fournisseur et le numéro de facture. Les compter deux fois doublerait
//                la sous-traitance et les matériaux.
//   C  écarté  — engagements de contrat (soumissions retenues), pas des dépenses. Chez CRC :
//                336 écritures pour 7,9 M$ sur douze mois, soit des octrois de
//                sous-traitance, non des factures reçues.
//   R  écarté  — journal des produits. Il alimente les REVENUS, jamais les charges.
//   X  écarté  — écritures d'exception, à examiner à la main si le montant grossit.
const JOURNAUX_CHARGE = ['E', 'B'];
const JOURNAUX_ECARTES = {
  P: 'contrepartie des factures fournisseurs — déjà dans PYBBIL',
  C: 'engagements de contrat — pas des dépenses',
  R: 'journal des produits — compté dans les revenus',
  X: 'écritures d\'exception',
};

// Totaux par journal sur la période : sert à afficher ce qui a été écarté, et à vérifier
// que l'hypothèse du doublon tient encore.
function totauxParJournal(debut, fin) {
  const c = {
    date: champ('TRANS', 'date'), journal: champ('TRANS', 'journal'),
    montant: champ('TRANS', 'montant'), numeroGl: champ('TRANS', 'numeroGl'),
  };
  const parType = {};
  dbf.lireTable(fichier('TRANS'), {
    meta: meta('TRANS'),
    filtre: l => {
      if (!dansPeriode(gl.normaliserDate(l[c.date]), debut, fin)) return false;
      const type = String(l[c.journal] || '').trim().charAt(0).toUpperCase() || '?';
      const m = gl.nombre(l[c.montant]);
      if (!parType[type]) parType[type] = { nb: 0, montant: 0 };
      parType[type].nb++;
      parType[type].montant += m;
      return false;
    },
  });
  return parType;
}

// Revenus lus dans le grand livre, quand FACTMA est chiffrée et donc inutilisable.
// Les comptes 31xxx portent la facturation client ; TFACT donne le numéro de facture, ce
// qui préserve le drill-down jusqu'à la pièce.
function lireRevenusGrandLivre(debut, fin) {
  const m = meta('TRANS');
  const noms = m.champs.map(x => x.nom);
  const c = {
    numeroProjet: champ('TRANS', 'numeroProjet') || noms[0],
    numeroGl: champ('TRANS', 'numeroGl') || noms[1],
    date: champ('TRANS', 'date') || noms[2],
    journal: champ('TRANS', 'journal') || noms[3],
    montant: champ('TRANS', 'montant') || noms[4],
    facture: noms[7] || null,
  };
  const { estCompteRevenu } = require('../config/plan-comptable');

  const sorties = [];
  dbf.lireTable(fichier('TRANS'), {
    meta: m,
    filtre: l => {
      const compte = String(l[c.numeroGl] === null ? '' : l[c.numeroGl]).trim();
      if (!estCompteRevenu(compte)) return false;
      const date = gl.normaliserDate(l[c.date]);
      if (!dansPeriode(date, debut, fin)) return false;
      const montant = gl.nombre(l[c.montant]);
      if (!montant) return false;

      const journal = String(l[c.journal] || '').trim();
      const facture = c.facture ? String(l[c.facture] === null ? '' : l[c.facture]).trim() : '';
      sorties.push({
        numeroFacture: facture || journal,
        numeroProjet: gl.normaliserProjet(l[c.numeroProjet]),
        client: '',
        date,
        montant,
        soldeOuvert: 0,
        retenue: 0,
        noteCredit: false,
        numeroGl: compte,
        source: 'TRANS.DBF',
      });
      return false;
    },
  });
  return sorties;
}

function lireEcritures(debut, fin) {
  const c = {
    numeroProjet: champ('TRANS', 'numeroProjet'), numeroGl: champ('TRANS', 'numeroGl'),
    date: champ('TRANS', 'date'), journal: champ('TRANS', 'journal'),
    montant: champ('TRANS', 'montant'), codeActivite: champ('TRANS', 'codeActivite'),
  };
  const { estCompteRevenu } = require('../config/plan-comptable');
  const lignes = dbf.lireTable(fichier('TRANS'), {
    meta: meta('TRANS'),
    filtre: l => {
      const journal = String(l[c.journal] || '').trim();
      const type = journal.charAt(0).toUpperCase();
      if (!JOURNAUX_CHARGE.includes(type)) return false;
      // Un compte de produits égaré dans un journal de charge viendrait en diminution
      // des coûts et gonflerait la marge : on l'écarte explicitement.
      if (estCompteRevenu(String(l[c.numeroGl] === null ? '' : l[c.numeroGl]).trim())) return false;
      if (!gl.nombre(l[c.montant])) return false;
      return dansPeriode(gl.normaliserDate(l[c.date]), debut, fin);
    },
  });
  return lignes.map(l => {
    const journal = String(l[c.journal] || '').trim();
    const type = journal.charAt(0).toUpperCase();
    const numeroProjet = gl.normaliserProjet(l[c.numeroProjet]);
    return {
      source: 'TRANS.DBF', numeroJournal: journal,
      date: gl.normaliserDate(l[c.date]), numeroFacture: '',
      description: type === 'E' ? 'Écriture salariale' : 'Transaction bancaire',
      fournisseur: type === 'E' ? 'Masse salariale' : 'Banque',
      numeroProjet, estProjet: numeroProjet !== '',
      codeActivite: gl.normaliserActivite(l[c.codeActivite]),
      numeroGl: String(l[c.numeroGl] === null ? '' : l[c.numeroGl]).trim(),
      montant: gl.nombre(l[c.montant]), typeTransaction: type, estMo: type === 'E',
    };
  });
}

// CONTRA porte des en-têtes connus (CONUM, CONOM…), donc pas de déduction nécessaire.
function lireProjets() {
  const m = meta('CONTRA');
  const noms = m.champs.map(c => c.nom.toUpperCase());
  const trouver = (...cands) => {
    for (const c of cands) {
      const i = noms.indexOf(c.toUpperCase());
      if (i !== -1) return m.champs[i].nom;
    }
    return null;
  };
  const cNum = trouver('CONUM'), cNom = trouver('CONOM'), cCli = trouver('COCLINOM', 'COCLI');
  if (!cNum) return {};

  const map = {};
  dbf.lireTable(fichier('CONTRA'), {
    meta: m,
    filtre: l => {
      const num = gl.normaliserProjet(l[cNum]);
      if (num) {
        map[num] = {
          nom: cNom ? String(l[cNom] || '').trim() : '',
          client: cCli ? String(l[cCli] || '').trim() : '',
        };
      }
      return false;
    },
  });
  return map;
}

function lireActivites() {
  const m = meta('ACTIVE');
  const cCode = champ('ACTIVE', 'code') || m.champs[0].nom;
  const cNom = champ('ACTIVE', 'nom') || (m.champs[1] && m.champs[1].nom);
  const map = {};
  dbf.lireTable(fichier('ACTIVE'), {
    meta: m,
    filtre: l => {
      const code = gl.normaliserActivite(l[cCode]);
      if (code && cNom) map[code] = String(l[cNom] || '').trim();
      return false;
    },
  });
  return map;
}

function lireCommandeDivisions() {
  const m = meta('COMITE');
  const cCmd = champ('COMITE', 'numeroCommande'), cAct = champ('COMITE', 'codeActivite');
  if (!cCmd || !cAct) return {};
  const map = {};
  dbf.lireTable(fichier('COMITE'), {
    meta: m,
    filtre: l => {
      const cmd = String(l[cCmd] === null ? '' : l[cCmd]).trim().padStart(9, '0');
      const act = gl.normaliserActivite(l[cAct]);
      if (cmd && cmd !== '000000000' && act && !map[cmd]) map[cmd] = act;
      return false;
    },
  });
  return map;
}

function inventaire() {
  return { repertoire: repertoire(), tables: dbf.inventaire(repertoire(), TABLES_ATTENDUES) };
}

// Le contenu de cette table se décode-t-il ? Avantage chiffre certaines tables : les noms
// de champs restent lisibles, les valeurs non. Sans ce contrôle, l'échec de résolution se
// présente comme « date incohérente » alors que la vraie cause est le chiffrement, et on
// cherche un mappage qui n'existe pas.
function lisibilite(table) {
  const f = fichier(table);
  if (!f) return null;
  try { return dbf.lisibilite(f, meta(table), 200); } catch (e) { return null; }
}

module.exports = {
  disponible, raisonIndisponible, repertoire, aTable, listerColonnes, echantillonner,
  lireFactures, lireRevenusGrandLivre, lireChargesFournisseurs, lireEcritures, lireProjets,
  lireActivites, lireCommandeDivisions, totauxParJournal, inventaire, lisibilite, meta,
  TABLES_ATTENDUES, JOURNAUX_CHARGE, JOURNAUX_ECARTES,
};
