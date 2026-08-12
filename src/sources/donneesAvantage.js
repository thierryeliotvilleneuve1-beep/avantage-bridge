// Source unique de vérité pour les données Avantage.
//
// Trois voies, essayées dans cet ordre :
//
//   1. DBF   — les fichiers .DBF sont la base Avantage elle-même (A:\AVA01\PYBBIL.DBF…).
//              Toujours à jour, et ils déclarent leurs noms de champs dans leur en-tête.
//              C'est la voie normale.
//   2. ODBC  — si un DSN est configuré et que les .DBF ne sont pas accessibles.
//   3. CSV   — les exports, en dernier recours. Ils sont figés à la date de l'export.
//
// La voie réellement employée pour chaque jeu de données est enregistrée et remontée dans
// le diagnostic : on sait toujours d'où vient chaque chiffre, et de quand il date.
//
// LECTURE SEULE — aucune voie n'écrit dans Avantage.

const fs = require('fs');
const path = require('path');
const cx = require('../db/connexion');
const dbfDepot = require('./depotDbf');
const autoMappage = require('../db/autoMappage');
const { TABLES, estLisibleEnBd } = require('../config/colonnes-avantage');
const gl = require('../parsers/parseGrandLivre');
const { parseActive } = require('../parsers/parseActive');
const { parse } = require('csv-parse/sync');

// Surchargeable par AVANTAGE_EXPORT_DIR, ce qui permet de faire tourner les tests
// sur un jeu de données de contrôle sans toucher aux exports de production.
const EXPORT_DIR = process.env.AVANTAGE_EXPORT_DIR
  ? path.resolve(process.env.AVANTAGE_EXPORT_DIR)
  : path.resolve(__dirname, '../../exports-avantage');

// Journal des provenances, réinitialisé à chaque construction d'état des résultats.
let provenances = {};
function noter(jeu, mode, detail) { provenances[jeu] = { mode, detail }; }
function reinitialiser() { provenances = {}; }
function provenance() { return provenances; }

// ── Auto-mappage des colonnes ────────────────────────────────────────────────────
// Les noms de champs sont déduits puis validés sur les données réelles. Tenté une seule
// fois par démarrage. Le dépôt DBF est privilégié : il expose de vrais noms de champs.
let mappageTente = false;
let mappageResultats = [];

function depotIntrospection() {
  if (dbfDepot.disponible()) return { nom: 'dbf', depot: dbfDepot };
  if (cx.disponible()) return { nom: 'odbc', depot: cx };
  return null;
}

async function autoMapper(forcer) {
  if (mappageTente && !forcer) return mappageResultats;
  mappageTente = true;
  mappageResultats = [];

  const src = depotIntrospection();
  if (!src) return mappageResultats;

  for (const t of Object.keys(TABLES)) {
    if (estLisibleEnBd(t)) continue;
    // Inutile de tenter une table absente du répertoire DBF.
    if (src.nom === 'dbf' && !dbfDepot.aTable(t)) {
      mappageResultats.push({ table: t, retenu: false, raison: 'fichier ' + t + '.DBF absent' });
      continue;
    }
    try {
      const r = await autoMappage.deduire(t, src.depot);
      r.voie = src.nom;
      if (r.retenu) autoMappage.appliquer(r);

      // Un échec de résolution sur une table chiffrée n'est pas un problème de mappage :
      // aucun nom de colonne ne le corrigera. On nomme la vraie cause, sinon on cherche
      // longtemps une correspondance qui n'existe pas.
      if (!r.retenu && src.nom === 'dbf') {
        const lis = dbfDepot.lisibilite(t);
        if (lis && lis.verdict === 'illisible') {
          r.contenu_illisible = lis;
          r.raison = 'contenu illisible (chiffré par Avantage ou format inconnu) — ' +
            lis.taux + ' % des dates et nombres se décodent sur ' +
            lis.valeurs_examinees + ' valeurs. Aucun mappage ne corrigera cela : ' +
            'il faut une autre source pour cette table.';
        }
      }

      mappageResultats.push(r);
      console.log('[INFO] mappage ' + t + ' (' + src.nom + ') : ' +
        (r.retenu ? 'retenu' : 'refusé — ' + r.raison));
    } catch (e) {
      mappageResultats.push({ table: t, retenu: false, voie: src.nom, raison: e.message });
      console.log('[WARN] mappage ' + t + ' : ' + e.message);
    }
  }
  return mappageResultats;
}

// Une table est lisible en DBF si le fichier existe et que ses colonnes sont résolues.
function lisibleEnDbf(table) {
  return dbfDepot.disponible() && dbfDepot.aTable(table) && estLisibleEnBd(table);
}

function fraicheur(table) {
  try {
    const inv = dbfDepot.inventaire().tables[table];
    return inv && inv.present ? inv.nb_enregistrements + ' enregistrements, modifié ' + inv.modifie : '';
  } catch (e) { return ''; }
}

function cheminCsv(nom) { return path.join(EXPORT_DIR, nom + '.csv'); }
function csvExiste(nom) { return fs.existsSync(cheminCsv(nom)); }
function lireCsv(nom) { return fs.readFileSync(cheminCsv(nom), 'latin1'); }

function dansPeriode(date, debut, fin) {
  if (!date) return false;
  if (debut && date < debut) return false;
  if (fin && date > fin) return false;
  return true;
}

// --------------------------------------------------------------------------------
// Revenus — facturation client (FACTMA)
// --------------------------------------------------------------------------------
async function chargerRevenus(debut, fin) {
  if (lisibleEnDbf('FACTMA')) {
    try {
      const out = dbfDepot.lireFactures(debut, fin);
      noter('revenus', 'dbf', 'FACTMA.DBF — ' + out.length + ' factures · ' + fraicheur('FACTMA'));
      return out;
    } catch (e) { noter('revenus', 'erreur_dbf', e.message); }
  }

  if (cx.disponible() && estLisibleEnBd('FACTMA')) {
    try {
      const c = TABLES.FACTMA.colonnes;
      const champs = Object.values(c).map(x => x.bd).filter(Boolean);
      const rows = await cx.interroger('SELECT ' + champs.join(', ') + ' FROM ' + TABLES.FACTMA.table);
      const out = rows.map(r => {
        const credit = /^(t|true|o|oui|vrai|1)$/i.test(String(r[c.noteCredit.bd] || '').trim());
        const signe = credit ? -1 : 1;
        return {
          numeroFacture: String(r[c.numeroFacture.bd] || '').trim(),
          numeroProjet: gl.normaliserProjet(r[c.numeroProjet.bd]),
          client: String(r[c.client.bd] || '').trim(),
          date: gl.normaliserDate(r[c.date.bd]),
          montant: signe * gl.nombre(r[c.montant.bd]),
          soldeOuvert: signe * gl.nombre(r[c.soldeOuvert.bd]),
          retenue: signe * gl.nombre(r[c.retenue.bd]),
          noteCredit: credit,
        };
      }).filter(f => f.numeroFacture && dansPeriode(f.date, debut, fin));
      noter('revenus', 'bd', TABLES.FACTMA.table + ' — ' + out.length + ' factures');
      return out;
    } catch (e) { noter('revenus', 'erreur_bd', e.message); }
  }

  if (csvExiste('FACTMA')) {
    const out = gl.parseFactmaRevenus(lireCsv('FACTMA')).filter(f => dansPeriode(f.date, debut, fin));
    const st = fs.statSync(cheminCsv('FACTMA'));
    noter('revenus', 'csv', 'FACTMA.csv — ' + out.length + ' factures · export du ' +
      st.mtime.toISOString().slice(0, 10));
    return out;
  }

  noter('revenus', 'absent', 'Ni FACTMA.DBF, ni la base, ni FACTMA.csv ne sont accessibles.');
  return [];
}

// --------------------------------------------------------------------------------
// Charges — factures fournisseurs (PYBBIL) + écritures (TRANS)
// --------------------------------------------------------------------------------
async function chargerCharges(debut, fin) {
  const charges = [];

  // -- PYBBIL
  let faitPybbil = false;
  if (lisibleEnDbf('PYBBIL') && Array.isArray(TABLES.PYBBIL.pairesGl.bd)) {
    try {
      const lignes = dbfDepot.lireChargesFournisseurs(debut, fin);
      lignes.forEach(l => charges.push(l));
      noter('charges_fournisseurs', 'dbf',
        'PYBBIL.DBF — ' + lignes.length + ' lignes de ventilation · ' + fraicheur('PYBBIL'));
      faitPybbil = true;
    } catch (e) { noter('charges_fournisseurs', 'erreur_dbf', e.message); }
  }

  if (!faitPybbil && cx.disponible() && estLisibleEnBd('PYBBIL') && TABLES.PYBBIL.pairesGl.bd) {
    try {
      const c = TABLES.PYBBIL.colonnes;
      const paires = TABLES.PYBBIL.pairesGl.bd;
      const champs = Object.values(c).map(x => x.bd).filter(Boolean)
        .concat(paires.flatMap(p => [p.gl, p.montant]));
      const rows = await cx.interroger('SELECT ' + champs.join(', ') + ' FROM ' + TABLES.PYBBIL.table);
      const { GL_TAXES } = require('../config/plan-comptable');
      for (const r of rows) {
        const date = gl.normaliserDate(r[c.date.bd]);
        if (!dansPeriode(date, debut, fin)) continue;
        const numeroProjet = gl.normaliserProjet(r[c.numeroProjet.bd]);
        const commun = {
          source: 'PYBBIL', numeroJournal: 'P' + String(r[c.numeroSequence.bd] || '').trim(), date,
          numeroFacture: String(r[c.numeroFacture.bd] || '').trim(),
          description: String(r[c.description.bd] || '').trim(),
          fournisseur: String(r[c.nomFournisseur.bd] || r[c.numeroFourn.bd] || '').trim(),
          numeroProjet, estProjet: numeroProjet !== '',
          numeroCommande: String(r[c.numeroCommande.bd] || '').trim(), typeTransaction: 'P',
        };
        let ajoutees = 0;
        for (const p of paires) {
          const g = String(r[p.gl] || '').trim();
          const m = gl.nombre(r[p.montant]);
          if (!g || GL_TAXES.includes(g) || !m) continue;
          charges.push(Object.assign({}, commun, { numeroGl: g, montant: m }));
          ajoutees++;
        }
        if (!ajoutees) {
          const total = gl.nombre(r[c.montantTotal.bd]);
          if (total) charges.push(Object.assign({}, commun, { numeroGl: '', montant: total }));
        }
      }
      noter('charges_fournisseurs', 'bd', TABLES.PYBBIL.table);
      faitPybbil = true;
    } catch (e) { noter('charges_fournisseurs', 'erreur_bd', e.message); }
  }

  if (!faitPybbil) {
    if (csvExiste('PYBBIL')) {
      const lignes = gl.parsePybbil(lireCsv('PYBBIL')).filter(l => dansPeriode(l.date, debut, fin));
      lignes.forEach(l => charges.push(l));
      const st = fs.statSync(cheminCsv('PYBBIL'));
      noter('charges_fournisseurs', 'csv', 'PYBBIL.csv — ' + lignes.length +
        ' lignes · export du ' + st.mtime.toISOString().slice(0, 10));
    } else {
      noter('charges_fournisseurs', 'absent',
        'PYBBIL introuvable, ni en .DBF ni en .csv. Sans lui, aucune charge fournisseur ' +
        'ni frais général ne peut être calculé.');
    }
  }

  // -- TRANS
  let faitTrans = false;
  if (lisibleEnDbf('TRANS')) {
    try {
      const lignes = dbfDepot.lireEcritures(debut, fin);
      lignes.forEach(l => charges.push(l));
      noter('ecritures', 'dbf', 'TRANS.DBF — ' + lignes.length + ' écritures · ' + fraicheur('TRANS'));
      faitTrans = true;
    } catch (e) { noter('ecritures', 'erreur_dbf', e.message); }
  }

  if (!faitTrans && cx.disponible() && estLisibleEnBd('TRANS')) {
    try {
      const c = TABLES.TRANS.colonnes;
      const rows = await cx.interroger('SELECT ' + Object.values(c).map(x => x.bd).filter(Boolean).join(', ') +
        ' FROM ' + TABLES.TRANS.table);
      for (const r of rows) {
        const journal = String(r[c.journal.bd] || '').trim();
        const type = journal.charAt(0);
        if (type !== 'E' && type !== 'B') continue;
        const date = gl.normaliserDate(r[c.date.bd]);
        if (!dansPeriode(date, debut, fin)) continue;
        const montant = gl.nombre(r[c.montant.bd]);
        if (!montant) continue;
        const numeroProjet = gl.normaliserProjet(r[c.numeroProjet.bd]);
        charges.push({
          source: 'TRANS', numeroJournal: journal, date, numeroFacture: '',
          description: type === 'E' ? 'Écriture salariale' : 'Transaction bancaire',
          fournisseur: type === 'E' ? 'Masse salariale' : 'Banque',
          numeroProjet, estProjet: numeroProjet !== '',
          codeActivite: gl.normaliserActivite(r[c.codeActivite.bd]),
          numeroGl: String(r[c.numeroGl.bd] || '').trim(),
          montant, typeTransaction: type, estMo: type === 'E',
        });
      }
      noter('ecritures', 'bd', TABLES.TRANS.table);
      faitTrans = true;
    } catch (e) { noter('ecritures', 'erreur_bd', e.message); }
  }

  if (!faitTrans) {
    if (csvExiste('TRANS')) {
      const lignes = gl.parseTrans(lireCsv('TRANS')).filter(l => dansPeriode(l.date, debut, fin));
      lignes.forEach(l => charges.push(l));
      noter('ecritures', 'csv', 'TRANS.csv — ' + lignes.length + ' écritures');
    } else {
      noter('ecritures', 'absent', 'TRANS introuvable — la main-d\'oeuvre imputée sera absente.');
    }
  }

  return charges;
}

// --------------------------------------------------------------------------------
// Référentiels
// --------------------------------------------------------------------------------
async function chargerProjets() {
  if (dbfDepot.disponible() && dbfDepot.aTable('CONTRA')) {
    try {
      const map = dbfDepot.lireProjets();
      if (Object.keys(map).length) {
        noter('projets', 'dbf', 'CONTRA.DBF — ' + Object.keys(map).length + ' projets');
        return map;
      }
    } catch (e) { noter('projets', 'erreur_dbf', e.message); }
  }

  if (cx.disponible() && estLisibleEnBd('CONTRA')) {
    try {
      const c = TABLES.CONTRA.colonnes;
      const rows = await cx.interroger('SELECT ' + Object.values(c).map(x => x.bd).filter(Boolean).join(', ') +
        ' FROM ' + TABLES.CONTRA.table);
      const map = {};
      rows.forEach(r => {
        const num = gl.normaliserProjet(r[c.numeroProjet.bd]);
        if (num) map[num] = { nom: String(r[c.nom.bd] || '').trim(), client: String(r[c.client.bd] || '').trim() };
      });
      noter('projets', 'bd', TABLES.CONTRA.table + ' — ' + Object.keys(map).length + ' projets');
      return map;
    } catch (e) { noter('projets', 'erreur_bd', e.message); }
  }

  if (csvExiste('CONTRA')) {
    const map = gl.parseContraProjets(lireCsv('CONTRA'));
    noter('projets', 'csv', 'CONTRA.csv — ' + Object.keys(map).length + ' projets');
    return map;
  }

  noter('projets', 'absent', 'CONTRA introuvable — les projets s\'afficheront par numéro.');
  return {};
}

async function chargerActivites() {
  if (dbfDepot.disponible() && dbfDepot.aTable('ACTIVE') && estLisibleEnBd('ACTIVE')) {
    try {
      const map = dbfDepot.lireActivites();
      if (Object.keys(map).length) {
        noter('activites', 'dbf', 'ACTIVE.DBF — ' + Object.keys(map).length + ' divisions');
        return map;
      }
    } catch (e) { noter('activites', 'erreur_dbf', e.message); }
  }
  if (csvExiste('ACTIVE')) {
    const map = parseActive(lireCsv('ACTIVE'));
    noter('activites', 'csv', 'ACTIVE.csv — ' + Object.keys(map).length + ' divisions');
    return map;
  }
  noter('activites', 'absent', 'ACTIVE introuvable — les divisions s\'afficheront par code.');
  return {};
}

async function chargerCommandeDivisions() {
  if (dbfDepot.disponible() && dbfDepot.aTable('COMITE') && estLisibleEnBd('COMITE')) {
    try {
      const map = dbfDepot.lireCommandeDivisions();
      if (Object.keys(map).length) {
        noter('commandes', 'dbf', 'COMITE.DBF — ' + Object.keys(map).length + ' commandes');
        return map;
      }
    } catch (e) { noter('commandes', 'erreur_dbf', e.message); }
  }
  if (csvExiste('COMITE')) {
    const map = gl.parseComiteDivisions(lireCsv('COMITE'));
    noter('commandes', 'csv', 'COMITE.csv — ' + Object.keys(map).length + ' commandes');
    return map;
  }
  noter('commandes', 'absent', 'COMITE introuvable — pas de division CSI sur les factures.');
  return {};
}

// --------------------------------------------------------------------------------
// Diagnostic : ce que le bridge voit réellement.
// --------------------------------------------------------------------------------
function etatSources() {
  const fichiers = {};
  for (const nom of ['PYBBIL', 'TRANS', 'FACTMA', 'CONTRA', 'CONACT', 'CONPRE', 'ACTIVE', 'COMITE']) {
    const p = cheminCsv(nom);
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      fichiers[nom] = {
        present: true,
        taille_mo: Math.round((st.size / 1048576) * 100) / 100,
        modifie: st.mtime.toISOString(),
      };
    } else {
      fichiers[nom] = { present: false };
    }
  }

  let dbfInfo;
  try {
    dbfInfo = dbfDepot.disponible()
      ? dbfDepot.inventaire()
      : { disponible: false, raison: dbfDepot.raisonIndisponible(), repertoire: dbfDepot.repertoire() };
  } catch (e) {
    dbfInfo = { disponible: false, erreur: e.message, repertoire: dbfDepot.repertoire() };
  }

  return {
    voie_retenue: dbfDepot.disponible() ? 'dbf' : (cx.disponible() ? 'odbc' : 'csv'),
    fichiers_dbf: dbfInfo,
    base_odbc: {
      disponible: cx.disponible(),
      raison: cx.raisonIndisponible(),
      voie: cx.voie(),
    },
    repertoire_exports: EXPORT_DIR,
    fichiers_csv: fichiers,
    tables_resolues: Object.keys(TABLES).filter(t => estLisibleEnBd(t)),
    tables_a_resoudre: Object.keys(TABLES).filter(t => !estLisibleEnBd(t)),
    mappage: mappageResultats.map(r => ({
      table: r.table, retenu: r.retenu, voie: r.voie, raison: r.raison,
    })),
  };
}

// Le détail des mappages refusés, avec les noms de colonnes réels de la table. C'est ce
// qu'il faut lire pour corriger une résolution qui échoue sur une vraie installation.
function mappagesRefuses() {
  return mappageResultats.filter(r => !r.retenu);
}

module.exports = {
  chargerRevenus, chargerCharges, chargerProjets, chargerActivites, chargerCommandeDivisions,
  etatSources, provenance, reinitialiser, autoMapper, mappagesRefuses, EXPORT_DIR,
};
