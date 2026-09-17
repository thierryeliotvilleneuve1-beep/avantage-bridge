const { upsert, idOf, sleep } = require('../writers/base44-writer');
const { rowsFor } = require('./dataset');
const { findProjet, indexBy } = require('./snapshot');

// Activite main-d'oeuvre: le cout va dans mo_total, pas dans engage.
const MO_CODES = ['06101'];

// Pousse le controle budgetaire d'un projet (budget previsionnel, depenses
// reelles issues du grand livre, montants factures au client). Retourne le
// divMap code_division -> id Base44, ids crees inclus, pour que le sync des
// transactions puisse s'y rattacher.
async function syncBudget(codeRaw, ds, snap) {
  const code = codeRaw.replace(/^P/i, '').trim();

  const projet = findProjet(snap.Projet, code);
  if (!projet) return { ok: false, projet: code, error: 'Projet ' + code + ' non trouve dans Base44' };
  const projetId = idOf(projet);

  const phasesBudget = rowsFor(ds.index.budget, code);

  // Montants factures au client, par activite
  const factureMap = {};
  for (const r of rowsFor(ds.index.facturation, code)) {
    if (r.activite) factureMap[r.activite] = (factureMap[r.activite] || 0) + r.facture;
  }

  // Depenses reelles: grand livre projet, type R (comptes-clients) exclu.
  const transMap = {};
  for (const r of rowsFor(ds.index.transactions, code)) {
    if ((r.journal || '').charAt(0) === 'R') continue;
    if (r.activite) transMap[r.activite] = (transMap[r.activite] || 0) + r.montant;
  }

  // Activites depensees mais absentes du budget previsionnel
  const codesBudget = new Set(phasesBudget.map(r => r.activite));
  const phasesExtra = Object.keys(transMap)
    .filter(a => !codesBudget.has(a) && transMap[a] > 0 && a.trim() !== '')
    .map(a => ({ activite: a, montant: 0, _hors_budget: true }));

  const allPhases = [...phasesBudget, ...phasesExtra];
  if (!allPhases.length) return { ok: false, projet: code, projet_id: projetId, error: 'Aucune activite pour le projet ' + code };

  const divMap = indexBy(snap.ControleBudgetaire, projetId, 'code_division');

  let created = 0, updated = 0, errors = 0;
  for (const ph of allPhases) {
    const code_act = ph.activite;
    const isMO = MO_CODES.includes(code_act);
    const budget = ph.montant || 0;
    const engage = isMO ? 0 : (transMap[code_act] || 0);
    const mo_total = isMO ? (transMap[code_act] || 0) : 0;

    const div = {
      projet_id: projetId, code_division: code_act, nom_division: ds.actMap[code_act] || code_act,
      montant_initial: budget, montant_revise: 0, engage, mo_total,
      prevision_total: 0,
      facture: factureMap[code_act] || 0,
      recup_pertes: parseFloat((engage + mo_total - budget).toFixed(2)),
      pourcentage: budget > 0 ? parseFloat(((engage + mo_total) / budget * 100).toFixed(2)) : 0,
      directives_travaux: 0, travaux_crc: 0, credit_admin: 0, asse_caut: 0, decompte_crc: 0,
      sync_avantage_ts: new Date().toISOString(),
    };

    const existingId = divMap[code_act];
    const r = await upsert('ControleBudgetaire', existingId || null, div);
    if (r.ok) {
      if (existingId) updated++;
      else { created++; if (r.body && idOf(r.body)) divMap[code_act] = idOf(r.body); }
    } else errors++;
    await sleep(150);
  }

  return { ok: true, projet: code, projet_id: projetId, phases: allPhases.length, created, updated, errors, divMap };
}

module.exports = { syncBudget, MO_CODES };
