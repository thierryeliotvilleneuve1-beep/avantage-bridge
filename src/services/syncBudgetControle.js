// Écrit le contrôle budgétaire d'un projet dans l'entité ControleBudgetaire de Manoeuvre,
// à partir de l'aperçu reconstruit de la BD (validé au cent près contre l'écran Avantage).
//
// N'écrit QUE les champs dont Avantage est la source de vérité :
//   montant_initial (budget coûts), budget_revenus (coûts + profit),
//   facture (facturé), engage (coûts engagés), mo_total (main-d'oeuvre).
// Les champs calculés par Manoeuvre (cout_engage, etc.) et les saisies manuelles
// (directives, avenants…) ne sont JAMAIS touchés.

const budgetDbf = require('../sources/budgetDbf');
const { upsert, idOf, inchange, sleep } = require('../writers/base44-writer');
const { trouverProjet } = require('./pousseurTransactions');

// Champs comparés pour le différentiel (on ne réécrit que si un a changé).
const CHAMPS = ['montant_initial', 'budget_revenus', 'facture', 'engage', 'depense', 'mo_total', 'nom_division'];

async function syncBudgetControle(code, ctx, actMap) {
  const projet = trouverProjet(ctx.projets, code);
  if (!projet) return { ok: false, projet: code, error: 'Projet absent de Manoeuvre' };
  const projetId = idOf(projet);

  const ap = budgetDbf.apercu(code);
  if (!ap.divisions.length) return { ok: true, projet: code, projet_id: projetId, divisions: 0, created: 0, updated: 0, unchanged: 0, errors: 0 };

  const existing = {};
  ctx.divisions.filter(x => x.projet_id === projetId).forEach(x => { if (x.code_division) existing[x.code_division] = x; });

  let created = 0, updated = 0, unchanged = 0, errors = 0;
  for (const d of ap.divisions) {
    const ex = existing[d.division];
    const payload = {
      projet_id: projetId,
      code_division: d.division,
      nom_division: (ex && ex.nom_division) || (actMap && actMap[d.division]) || d.division,
      montant_initial: d.budget_cout,
      budget_revenus: d.budget_revenu,
      facture: d.facture,
      engage: d.engage,
      depense: d.depense,
      mo_total: d.mo,
    };
    if (ex && inchange(ex, payload, CHAMPS)) { unchanged++; continue; }
    payload.sync_avantage_ts = new Date().toISOString();
    const r = await upsert('ControleBudgetaire', ex ? idOf(ex) : null, payload);
    if (r.ok) { ex ? updated++ : created++; } else errors++;
    await sleep(60);
  }

  return { ok: true, projet: code, projet_id: projetId, divisions: ap.divisions.length, created, updated, unchanged, errors };
}

module.exports = { syncBudgetControle };
