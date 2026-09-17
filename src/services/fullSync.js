const cfg = require('../config');
const { avecSource, choisir } = require('../sources');
const { buildDataset } = require('./dataset');
const { loadSnapshot, findProjet, estActif, codeAvantage } = require('./snapshot');
const { syncBudget } = require('./syncBudget');
const { syncBc } = require('./syncBc');
const { syncTrans } = require('./syncTrans');
const { writeProjets, writeFactures, idOf } = require('../writers/base44-writer');
const { fingerprint, hash, loadState, saveState } = require('./fingerprint');

const state = {
  running: false,
  started_at: null,
  last_sync: null,
  last_duration_s: null,
  last_result: null,
  last_error: null,
  source: null,
  repli: null,
  runs: 0,
};

function log(...a) { console.log('[SYNC]', ...a); }

// Codes projet a synchroniser: liste explicite via SYNC_PROJETS, sinon
// tous les projets actifs presents dans Manoeuvre.
function resolveCodes(snap) {
  if (cfg.SYNC_PROJETS && cfg.SYNC_PROJETS !== 'auto') {
    return cfg.SYNC_PROJETS.split(',').map(s => s.trim().replace(/^P/i, '')).filter(Boolean);
  }
  return snap.Projet.filter(estActif).map(p => codeAvantage(p.code_projet)).filter(Boolean);
}

async function runFullSync(opts) {
  const options = opts || {};
  if (state.running) {
    return { ok: false, skipped: true, reason: 'Un sync est deja en cours depuis ' + state.started_at };
  }
  state.running = true;
  state.started_at = new Date().toISOString();
  const t0 = Date.now();
  const etatSource = {};
  const result = { started_at: state.started_at, etapes: {}, projets: [] };

  try {
    const persisted = loadState();
    persisted.projets = persisted.projets || {};
    persisted.global = persisted.global || {};
    const skipUnchanged = cfg.SKIP_UNCHANGED && options.force !== true;

    // 1. Preparation de la source (conversion du classeur, ou rien pour la BD)
    result.etapes.preparation = await avecSource(s => s.prepare(options.forceConvert === true), etatSource);

    // 2. Projets et factures client
    const entetes = await avecSource(s => s.loadProjets(), etatSource);
    result.source = etatSource.source;
    result.repli_xlsx = etatSource.repli;
    log('Source:', result.source + (result.repli_xlsx ? ' (repli: ' + result.repli_xlsx + ')' : ''));

    if (!entetes.projets.length) throw new Error('Aucun projet lu depuis Avantage — source ' + result.source);

    const fpProjets = hash(entetes.projets);
    const fpFactures = hash(entetes.facturesClient);

    if (skipUnchanged && persisted.global.projets === fpProjets) {
      result.etapes.projets = { skipped: true, raison: 'liste des projets inchangee' };
    } else {
      result.etapes.projets = await writeProjets(entetes.projets);
      if (!result.etapes.projets.errors) persisted.global.projets = fpProjets;
    }
    log('Projets:', JSON.stringify(result.etapes.projets));

    if (entetes.facturesClient.length) {
      if (skipUnchanged && persisted.global.factures === fpFactures) {
        result.etapes.factures = { skipped: true, raison: 'factures client inchangees' };
      } else {
        result.etapes.factures = await writeFactures(entetes.facturesClient);
        if (!result.etapes.factures.errors) persisted.global.factures = fpFactures;
      }
      log('Factures:', JSON.stringify(result.etapes.factures));
    }

    // 3. Etat Base44, puis projets a traiter
    const snap = await loadSnapshot();
    result.etapes.base44 = {
      projets: snap.Projet.length, controles: snap.ControleBudgetaire.length,
      bons_commande: snap.BonDeCommande.length, transactions: snap.TransactionAvantage.length,
    };
    const codes = options.codes && options.codes.length
      ? options.codes.map(c => String(c).replace(/^P/i, '').trim())
      : resolveCodes(snap);
    result.projets_cibles = codes.length;
    log(codes.length + ' projet(s) a synchroniser');

    // 4. Detail budgetaire, filtre sur ces projets (pousse dans le SQL en mode BD)
    const detail = await avecSource(s => s.loadDetail(codes), etatSource);
    const ds = buildDataset(detail);
    result.etapes.lecture = ds.compte;
    result.age_heures = ds.age_heures;
    if (Object.keys(ds.colonnes_manquantes).length) {
      result.colonnes_manquantes = ds.colonnes_manquantes;
      log('AVERTISSEMENT colonnes non resolues:', JSON.stringify(ds.colonnes_manquantes));
    }
    if (ds.source === 'xlsx' && ds.age_heures !== null && ds.age_heures > cfg.MAX_EXPORT_AGE_HOURS) {
      result.avertissement = 'export.xlsx date de ' + ds.age_heures + ' h — refaire l\'export depuis Avantage.';
      log('AVERTISSEMENT:', result.avertissement);
    }
    log('Lignes lues:', JSON.stringify(ds.compte));

    // 5. Budget + BC + transactions, projet par projet
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
        entry.transactions = await syncTrans(code, ds, snap, { divMap: entry.budget.divMap, bcMap: entry.bc.bcMap });
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
    state.source = etatSource.source || null;
    state.repli = etatSource.repli || null;
    state.last_duration_s = Math.round((Date.now() - t0) / 1000);
    state.last_sync = new Date().toISOString();
    result.duree_s = state.last_duration_s;
    result.termine_a = state.last_sync;
    state.last_result = {
      ok: result.ok, source: state.source, projets: result.projets_cibles,
      inchanges: result.projets_inchanges, erreurs: result.erreurs,
      duree_s: result.duree_s, error: result.error || null,
    };
  }
  return result;
}

// Etat de fraicheur — repond a « est-ce que Manoeuvre est a jour ? »
function syncState() {
  const { exportAgeHours } = require('./convert');
  const sourceConfiguree = choisir();
  const age = sourceConfiguree === 'odbc' && !state.repli ? 0 : exportAgeHours();
  const perime = sourceConfiguree === 'odbc' && !state.repli
    ? false
    : (age === null || age > cfg.MAX_EXPORT_AGE_HOURS);

  return {
    running: state.running,
    source_configuree: sourceConfiguree,
    source_derniere_lecture: state.source,
    repli_xlsx: state.repli,
    started_at: state.started_at,
    last_sync: state.last_sync,
    last_duration_s: state.last_duration_s,
    last_result: state.last_result,
    last_error: state.last_error,
    runs: state.runs,
    export_age_heures: age,
    export_perime: perime,
    max_export_age_heures: cfg.MAX_EXPORT_AGE_HOURS,
    donnees_a_jour: !perime && !!state.last_sync && !!(state.last_result && state.last_result.ok),
  };
}

module.exports = { runFullSync, syncState, state };
