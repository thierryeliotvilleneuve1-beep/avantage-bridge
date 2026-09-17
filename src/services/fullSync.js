const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { convertXlsx, exportAgeHours, mtime } = require('./convert');
const { loadDataset } = require('./dataset');
const { loadSnapshot, findProjet, estActif, codeAvantage } = require('./snapshot');
const { syncBudget } = require('./syncBudget');
const { syncBc } = require('./syncBc');
const { syncTrans } = require('./syncTrans');
const { writeProjets, writeFactures, idOf } = require('../writers/base44-writer');
const { fingerprint, fileFingerprint, loadState, saveState } = require('./fingerprint');
const { parseContra } = require('../parsers/parseContra');
const { parseFactma } = require('../parsers/parseFactma');

const state = {
  running: false,
  started_at: null,
  last_sync: null,
  last_duration_s: null,
  last_result: null,
  last_error: null,
  runs: 0,
};

function log(...a) { console.log('[SYNC]', ...a); }

// Codes projet a synchroniser: liste explicite via SYNC_PROJETS, sinon
// tous les projets actifs presents dans Manoeuvre.
function resolveCodes(snap) {
  if (cfg.SYNC_PROJETS && cfg.SYNC_PROJETS !== 'auto') {
    return cfg.SYNC_PROJETS.split(',').map(s => s.trim().replace(/^P/i, '')).filter(Boolean);
  }
  return snap.Projet
    .filter(estActif)
    .map(p => codeAvantage(p.code_projet))
    .filter(Boolean);
}

async function runFullSync(opts) {
  const options = opts || {};
  if (state.running) {
    return { ok: false, skipped: true, reason: 'Un sync est deja en cours depuis ' + state.started_at };
  }
  state.running = true;
  state.started_at = new Date().toISOString();
  const t0 = Date.now();
  const result = { started_at: state.started_at, etapes: {}, projets: [] };

  try {
    // 1. export.xlsx -> CSV
    result.etapes.conversion = convertXlsx(options.forceConvert === true);
    result.export_age_heures = exportAgeHours();
    if (result.export_age_heures !== null && result.export_age_heures > cfg.MAX_EXPORT_AGE_HOURS) {
      result.avertissement = 'export.xlsx date de ' + result.export_age_heures + ' h — refaire l\'export depuis Avantage.';
      log('AVERTISSEMENT:', result.avertissement);
    }

    // 2. Lecture unique des exports Avantage
    const ds = loadDataset();
    result.etapes.lecture = {
      contra: ds.contra.length, factma: ds.factma.length, conpre: ds.conpre.rows.length,
      conact: ds.conact.length, trans: ds.trans.length, pybbil: ds.pybbil.length, comman: ds.comman.length,
    };
    log('Exports lus:', JSON.stringify(result.etapes.lecture));

    if (!ds.contra.length) throw new Error('CONTRA.csv absent ou vide — aucun projet a synchroniser');

    const persisted = loadState();
    persisted.projets = persisted.projets || {};
    persisted.fichiers = persisted.fichiers || {};
    const skipUnchanged = cfg.SKIP_UNCHANGED && options.force !== true;

    // 3. Projets + factures client — seulement si le fichier source a bouge.
    const contraPath = path.join(cfg.EXPORT_DIR, 'CONTRA.csv');
    const factmaPath = path.join(cfg.EXPORT_DIR, 'FACTMA.csv');
    const fpContra = fileFingerprint(contraPath);
    const fpFactma = fileFingerprint(factmaPath);

    if (skipUnchanged && fpContra && persisted.fichiers.CONTRA === fpContra) {
      result.etapes.projets = { skipped: true, raison: 'CONTRA.csv inchange' };
    } else {
      result.etapes.projets = await writeProjets(parseContra(fs.readFileSync(contraPath, 'latin1')));
      if (!result.etapes.projets.errors) persisted.fichiers.CONTRA = fpContra;
    }
    log('Projets:', JSON.stringify(result.etapes.projets));

    if (ds.factma.length) {
      if (skipUnchanged && fpFactma && persisted.fichiers.FACTMA === fpFactma) {
        result.etapes.factures = { skipped: true, raison: 'FACTMA.csv inchange' };
      } else {
        result.etapes.factures = await writeFactures(parseFactma(fs.readFileSync(factmaPath, 'latin1')));
        if (!result.etapes.factures.errors) persisted.fichiers.FACTMA = fpFactma;
      }
      log('Factures:', JSON.stringify(result.etapes.factures));
    }

    // 4. Etat Base44 apres creation des projets
    const snap = await loadSnapshot();
    result.etapes.base44 = {
      projets: snap.Projet.length, controles: snap.ControleBudgetaire.length,
      bons_commande: snap.BonDeCommande.length, transactions: snap.TransactionAvantage.length,
    };

    // 5. Budget + BC + transactions, projet par projet
    const codes = options.codes && options.codes.length
      ? options.codes.map(c => String(c).replace(/^P/i, '').trim())
      : resolveCodes(snap);
    result.projets_cibles = codes.length;
    log(codes.length + ' projet(s) a synchroniser');

    result.projets_inchanges = 0;

    for (const code of codes) {
      const entry = { code };
      try {
        const projet = findProjet(snap.Projet, code);
        if (!projet) { entry.error = 'absent de Manoeuvre'; result.projets.push(entry); continue; }
        entry.projet_id = idOf(projet);

        const fp = fingerprint(code, ds);
        if (skipUnchanged && persisted.projets[code] && persisted.projets[code].fingerprint === fp) {
          entry.skipped = true;
          entry.raison = 'aucun changement depuis ' + persisted.projets[code].sync;
          result.projets_inchanges++;
          result.projets.push(entry);
          continue;
        }

        entry.budget = await syncBudget(code, ds, snap);
        entry.bc = await syncBc(code, ds, snap);
        entry.transactions = await syncTrans(code, ds, snap, {
          divMap: entry.budget.divMap,
          bcMap: entry.bc.bcMap,
        });
        delete entry.budget.divMap;
        delete entry.bc.bcMap;
        const erreursProjet = (entry.budget.errors || 0) + (entry.bc.errors || 0) + (entry.transactions.errors || 0);
        if (!erreursProjet) persisted.projets[code] = { fingerprint: fp, sync: new Date().toISOString() };
        log('P' + code, 'budget:', entry.budget.phases || 0, 'BC:', entry.bc.bcs || 0, 'trans:', entry.transactions.total || 0);
      } catch (e) {
        entry.error = e.message;
        log('ERREUR P' + code + ':', e.message);
      }
      result.projets.push(entry);
    }

    persisted.last_sync = new Date().toISOString();
    saveState(persisted);

    result.ok = true;
    result.erreurs = result.projets.reduce((n, p) => n
      + (p.error ? 1 : 0)
      + ((p.budget && p.budget.errors) || 0)
      + ((p.bc && p.bc.errors) || 0)
      + ((p.transactions && p.transactions.errors) || 0), 0);
    state.last_error = null;
  } catch (e) {
    result.ok = false;
    result.error = e.message;
    state.last_error = e.message;
    log('ECHEC:', e.message);
  } finally {
    state.running = false;
    state.runs++;
    state.last_duration_s = Math.round((Date.now() - t0) / 1000);
    state.last_sync = new Date().toISOString();
    result.duree_s = state.last_duration_s;
    result.termine_a = state.last_sync;
    state.last_result = {
      ok: result.ok, projets: result.projets_cibles, inchanges: result.projets_inchanges,
      erreurs: result.erreurs, duree_s: result.duree_s, error: result.error || null,
    };
  }
  return result;
}

// Etat de fraicheur — repond a « est-ce que Manoeuvre est a jour ? »
function syncState() {
  const age = exportAgeHours();
  const perime = age === null || age > cfg.MAX_EXPORT_AGE_HOURS;
  return {
    running: state.running,
    started_at: state.started_at,
    last_sync: state.last_sync,
    last_duration_s: state.last_duration_s,
    last_result: state.last_result,
    last_error: state.last_error,
    runs: state.runs,
    export_xlsx: fs.existsSync(cfg.XLSX_PATH) ? new Date(mtime(cfg.XLSX_PATH)).toISOString() : null,
    export_age_heures: age,
    export_perime: perime,
    max_export_age_heures: cfg.MAX_EXPORT_AGE_HOURS,
    donnees_a_jour: !perime && !!state.last_sync && !!(state.last_result && state.last_result.ok),
  };
}

module.exports = { runFullSync, syncState, state };
