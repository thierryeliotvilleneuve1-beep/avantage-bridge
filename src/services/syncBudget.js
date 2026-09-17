const { upsert, idOf, sleep } = require('../writers/base44-writer');
const { rowsFor } = require('./dataset');
const { findProjet, indexBy } = require('./snapshot');

// Activite main-d'oeuvre: le cout va dans mo_total, pas dans engage.
const MO_CODES = ['06101'];

// Pousse le controle budgetaire d'un projet (CONPRE = budget, TRANS = depense reelle,
// CONACT = facture au client). Retourne le divMap code_division -> id Base44,
// ids nouvellement crees inclus, pour que le sync des transactions puisse s'y rattacher.
async function syncBudget(codeRaw, ds, snap) {
  const code = codeRaw.replace(/^P/i, '').trim();

  const projet = findProjet(snap.Projet, code);
  if (!projet) return { ok: false, projet: code, error: 'Projet ' + code + ' non trouve dans Base44' };
  const projetId = idOf(projet);

  if (!ds.conpre.rows.length) return { ok: false, projet: code, projet_id: projetId, error: 'CONPRE.csv introuvable ou vide' };

  const { kActivite, kMontant } = ds.conpre;
  const conprePhases = rowsFor(ds.index.conpre, code);

  // CONACT — [0]=projet [1]=activite [4]=facture_a_date (revenus client)
  const factureMap = {};
  rowsFor(ds.index.conact, code).forEach(r => {
    const act = (r[1] || '').trim().replace(/\.00$/, '');
    const facture = parseFloat((r[4] || '0').replace(',', '.')) || 0;
    if (act) factureMap[act] = (factureMap[act] || 0) + facture;
  });

  // TRANS — source unique des depenses reelles. R=comptes-clients (revenus) EXCLU, P/E/B inclus.
  const transMap = {};
  rowsFor(ds.index.trans, code)
    .filter(r => (r[3] || '').trim().charAt(0) !== 'R')
    .forEach(r => {
      const act = (r[5] || '').trim().replace(/\.00$/, '');
      const montant = parseFloat((r[4] || '0').replace(',', '.')) || 0;
      if (act) transMap[act] = (transMap[act] || 0) + montant;
    });

  const codesConpre = new Set(conprePhases.map(r => (r[kActivite] || '').trim().replace(/\.00$/, '')));
  const phasesExtra = Object.keys(transMap)
    .filter(act => !codesConpre.has(act) && transMap[act] > 0 && act.trim() !== '')
    .map(act => ({ _from_trans: true, _act: act }));

  const allPhases = [...conprePhases, ...phasesExtra];
  if (!allPhases.length) return { ok: false, projet: code, projet_id: projetId, error: 'Aucune activite pour le projet ' + code };

  const divMap = indexBy(snap.ControleBudgetaire, projetId, 'code_division');

  let created = 0, updated = 0, errors = 0;
  for (const ph of allPhases) {
    const code_act = ph._from_trans ? ph._act : (ph[kActivite] || '').trim().replace(/\.00$/, '');
    const isMO = MO_CODES.includes(code_act);
    const nom = ds.actMap[code_act] || code_act;
    const budget = ph._from_trans ? 0 : parseFloat((ph[kMontant] || '0').replace(',', '.')) || 0;
    const engage = isMO ? 0 : (transMap[code_act] || 0);
    const mo_total = isMO ? (transMap[code_act] || 0) : 0;

    const div = {
      projet_id: projetId, code_division: code_act, nom_division: nom,
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
