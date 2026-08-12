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

function lireEcritures(debut, fin) {
  const c = {
    numeroProjet: champ('TRANS', 'numeroProjet'), numeroGl: champ('TRANS', 'numeroGl'),
    date: champ('TRANS', 'date'), journal: champ('TRANS', 'journal'),
    montant: champ('TRANS', 'montant'), codeActivite: champ('TRANS', 'codeActivite'),
  };
  const lignes = dbf.lireTable(fichier('TRANS'), {
    meta: meta('TRANS'),
    filtre: l => {
      const journal = String(l[c.journal] || '').trim();
      const type = journal.charAt(0);
      if (type !== 'E' && type !== 'B') return false;
      if (!gl.nombre(l[c.montant])) return false;
      return dansPeriode(gl.normaliserDate(l[c.date]), debut, fin);
    },
  });
  return lignes.map(l => {
    const journal = String(l[c.journal] || '').trim();
    const type = journal.charAt(0);
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

module.exports = {
  disponible, raisonIndisponible, repertoire, aTable, listerColonnes, echantillonner,
  lireFactures, lireChargesFournisseurs, lireEcritures, lireProjets, lireActivites,
  lireCommandeDivisions, inventaire, meta, TABLES_ATTENDUES,
};
