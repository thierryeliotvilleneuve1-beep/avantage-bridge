// Source unique de vérité pour les données Avantage.
//
// Chaque jeu de données est cherché d'abord dans la BASE (lecture ODBC directe), puis
// dans l'export CSV si la base n'est pas joignable ou si les colonnes de la table ne
// sont pas encore mappées. Le mode réellement utilisé est enregistré et remonté dans le
// diagnostic : on sait toujours d'où vient chaque chiffre.

const fs = require('fs');
const path = require('path');
const cx = require('../db/connexion');
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
// Les tables dont les colonnes ne sont pas nommées dans la configuration sont déduites
// par position puis validées sur les données réelles. Tenté une seule fois par démarrage :
// inutile de réinterroger le pilote à chaque état des résultats.
let mappageTente = false;
let mappageResultats = [];

async function autoMapper(forcer) {
  if (mappageTente && !forcer) return mappageResultats;
  mappageTente = true;
  mappageResultats = [];
  if (!cx.disponible()) return mappageResultats;

  const aDeduire = Object.keys(TABLES).filter(t => !estLisibleEnBd(t));
  for (const t of aDeduire) {
    try {
      const r = await autoMappage.deduire(t, cx);
      if (r.retenu) autoMappage.appliquer(r);
      mappageResultats.push(r);
      console.log('[INFO] auto-mappage ' + t + ' : ' + (r.retenu ? 'retenu' : 'refusé — ' + r.raison));
    } catch (e) {
      mappageResultats.push({ table: t, retenu: false, raison: e.message });
      console.log('[WARN] auto-mappage ' + t + ' : ' + e.message);
    }
  }
  return mappageResultats;
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
  if (cx.disponible() && estLisibleEnBd('FACTMA')) {
    try {
      const c = TABLES.FACTMA.colonnes;
      const sql = 'SELECT ' + [
        c.numeroFacture.bd, c.numeroProjet.bd, c.client.bd, c.date.bd,
        c.montant.bd, c.soldeOuvert.bd, c.retenue.bd,
      ].join(', ') + ' FROM ' + TABLES.FACTMA.table;
      const rows = await cx.interroger(sql);
      const out = rows.map(r => ({
        numeroFacture: String(r[c.numeroFacture.bd] || '').trim(),
        numeroProjet: gl.normaliserProjet(r[c.numeroProjet.bd]),
        client: String(r[c.client.bd] || '').trim(),
        date: gl.normaliserDate(r[c.date.bd]),
        montant: gl.nombre(r[c.montant.bd]),
        soldeOuvert: gl.nombre(r[c.soldeOuvert.bd]),
        retenue: gl.nombre(r[c.retenue.bd]),
      })).filter(f => f.numeroFacture && dansPeriode(f.date, debut, fin));
      noter('revenus', 'bd', TABLES.FACTMA.table + ' — ' + out.length + ' factures');
      return out;
    } catch (e) {
      noter('revenus', 'erreur_bd', e.message);
    }
  }

  if (csvExiste('FACTMA')) {
    const out = gl.parseFactmaRevenus(lireCsv('FACTMA'))
      .filter(f => dansPeriode(f.date, debut, fin));
    noter('revenus', 'csv', 'FACTMA.csv — ' + out.length + ' factures');
    return out;
  }

  noter('revenus', 'absent', 'Ni la base ni FACTMA.csv ne sont accessibles.');
  return [];
}

// --------------------------------------------------------------------------------
// Charges — factures fournisseurs (PYBBIL) + écritures (TRANS)
// --------------------------------------------------------------------------------
async function chargerCharges(debut, fin) {
  const charges = [];

  // -- PYBBIL
  let faitEnBd = false;
  if (cx.disponible() && estLisibleEnBd('PYBBIL') && TABLES.PYBBIL.pairesGl.bd) {
    try {
      const c = TABLES.PYBBIL.colonnes;
      const paires = TABLES.PYBBIL.pairesGl.bd;
      const champs = Object.values(c).map(x => x.bd)
        .concat(paires.flatMap(p => [p.gl, p.montant]));
      const sql = 'SELECT ' + champs.join(', ') + ' FROM ' + TABLES.PYBBIL.table;
      const rows = await cx.interroger(sql);
      for (const r of rows) {
        const numeroProjet = gl.normaliserProjet(r[c.numeroProjet.bd]);
        const date = gl.normaliserDate(r[c.date.bd]);
        if (!dansPeriode(date, debut, fin)) continue;
        const commun = {
          source: 'PYBBIL',
          numeroJournal: 'P' + String(r[c.numeroSequence.bd] || '').trim(),
          date,
          numeroFacture: String(r[c.numeroFacture.bd] || '').trim(),
          description: String(r[c.description.bd] || '').trim(),
          fournisseur: String(r[c.nomFournisseur.bd] || r[c.numeroFourn.bd] || '').trim(),
          numeroProjet,
          estProjet: numeroProjet !== '',
          numeroCommande: String(r[c.numeroCommande.bd] || '').trim(),
          typeTransaction: 'P',
        };
        let ajoutees = 0;
        for (const p of paires) {
          const g = String(r[p.gl] || '').trim();
          const m = gl.nombre(r[p.montant]);
          if (!g || m === 0) continue;
          charges.push(Object.assign({}, commun, { numeroGl: g, montant: m }));
          ajoutees++;
        }
        if (!ajoutees) {
          const total = gl.nombre(r[c.montantTotal.bd]);
          if (total !== 0) charges.push(Object.assign({}, commun, { numeroGl: '', montant: total }));
        }
      }
      noter('charges_fournisseurs', 'bd', TABLES.PYBBIL.table);
      faitEnBd = true;
    } catch (e) {
      noter('charges_fournisseurs', 'erreur_bd', e.message);
    }
  }

  if (!faitEnBd) {
    if (csvExiste('PYBBIL')) {
      const lignes = gl.parsePybbil(lireCsv('PYBBIL')).filter(l => dansPeriode(l.date, debut, fin));
      lignes.forEach(l => charges.push(l));
      noter('charges_fournisseurs', 'csv', 'PYBBIL.csv — ' + lignes.length + ' lignes de ventilation');
    } else {
      noter('charges_fournisseurs', 'absent',
        'PYBBIL introuvable. Sans lui, aucune charge fournisseur ni frais général ne peut être calculé.');
    }
  }

  // -- TRANS (écritures salariales et bancaires)
  let transEnBd = false;
  if (cx.disponible() && estLisibleEnBd('TRANS')) {
    try {
      const c = TABLES.TRANS.colonnes;
      const sql = 'SELECT ' + Object.values(c).map(x => x.bd).join(', ') + ' FROM ' + TABLES.TRANS.table;
      const rows = await cx.interroger(sql);
      for (const r of rows) {
        const journal = String(r[c.journal.bd] || '').trim();
        const type = journal.charAt(0);
        if (type !== 'E' && type !== 'B') continue;
        const date = gl.normaliserDate(r[c.date.bd]);
        if (!dansPeriode(date, debut, fin)) continue;
        const montant = gl.nombre(r[c.montant.bd]);
        if (montant === 0) continue;
        const numeroProjet = gl.normaliserProjet(r[c.numeroProjet.bd]);
        charges.push({
          source: 'TRANS', numeroJournal: journal, date,
          numeroFacture: '',
          description: type === 'E' ? 'Écriture salariale' : 'Transaction bancaire',
          fournisseur: type === 'E' ? 'Masse salariale' : 'Banque',
          numeroProjet, estProjet: numeroProjet !== '',
          codeActivite: gl.normaliserActivite(r[c.codeActivite.bd]),
          numeroGl: String(r[c.numeroGl.bd] || '').trim(),
          montant, typeTransaction: type, estMo: type === 'E',
        });
      }
      noter('ecritures', 'bd', TABLES.TRANS.table);
      transEnBd = true;
    } catch (e) {
      noter('ecritures', 'erreur_bd', e.message);
    }
  }

  if (!transEnBd) {
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
  const map = {};
  if (cx.disponible() && estLisibleEnBd('CONTRA')) {
    try {
      const c = TABLES.CONTRA.colonnes;
      const sql = 'SELECT ' + Object.values(c).map(x => x.bd).join(', ') + ' FROM ' + TABLES.CONTRA.table;
      const rows = await cx.interroger(sql);
      rows.forEach(r => {
        const num = gl.normaliserProjet(r[c.numeroProjet.bd]);
        if (num) map[num] = { nom: String(r[c.nom.bd] || '').trim(), client: String(r[c.client.bd] || '').trim() };
      });
      noter('projets', 'bd', TABLES.CONTRA.table + ' — ' + Object.keys(map).length + ' projets');
      return map;
    } catch (e) { noter('projets', 'erreur_bd', e.message); }
  }
  if (csvExiste('CONTRA')) {
    const records = parse(lireCsv('CONTRA'), {
      columns: true, skip_empty_lines: true, trim: true,
      relax_column_count: true, relax_quotes: true,
    });
    records.forEach(r => {
      const num = gl.normaliserProjet(r.CONUM);
      if (num) map[num] = { nom: (r.CONOM || '').trim(), client: (r.COCLINOM || r.COCLI || '').trim() };
    });
    noter('projets', 'csv', 'CONTRA.csv — ' + Object.keys(map).length + ' projets');
    return map;
  }
  noter('projets', 'absent', 'CONTRA introuvable — les projets s\'afficheront par numéro.');
  return map;
}

async function chargerActivites() {
  if (csvExiste('ACTIVE')) {
    const map = parseActive(lireCsv('ACTIVE'));
    noter('activites', 'csv', 'ACTIVE.csv — ' + Object.keys(map).length + ' divisions');
    return map;
  }
  noter('activites', 'absent', 'ACTIVE introuvable — les divisions s\'afficheront par code.');
  return {};
}

async function chargerCommandeDivisions() {
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
  return {
    repertoire_exports: EXPORT_DIR,
    base_de_donnees: {
      disponible: cx.disponible(),
      raison: cx.raisonIndisponible(),
      dsn_configure: Boolean(process.env.AVANTAGE_DSN),
    },
    voie_acces_bd: cx.voie(),
    tables_mappees_vers_bd: Object.keys(TABLES).filter(t => estLisibleEnBd(t)),
    auto_mappage: mappageResultats.map(r => ({ table: r.table, retenu: r.retenu, raison: r.raison })),
    tables_a_mapper: Object.keys(TABLES).filter(t => !estLisibleEnBd(t)),
    fichiers_csv: fichiers,
  };
}

module.exports = {
  chargerRevenus, chargerCharges, chargerProjets, chargerActivites, chargerCommandeDivisions,
  etatSources, provenance, reinitialiser, autoMapper, EXPORT_DIR,
};
