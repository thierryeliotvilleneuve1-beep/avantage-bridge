// Écrit l'ENGAGÉ RÉEL (bons de commande COMMAN/COMITE, lus via SDK R09) dans le champ
// `engage` de l'entité ControleBudgetaire de Manœuvre, par division.
//
// Remplace le proxy « TRANS journal C » par l'engagé réel des BC fournisseurs ouverts.
// N'écrit QUE le champ `engage` (+ horodatage) : aucun autre champ n'est touché.
//
// DRY-RUN PAR DÉFAUT : sans opts.dryRun===false, rien n'est écrit — on renvoie le diff
// par division pour validation. L'écriture n'a lieu qu'avec apply explicite.

const { lireEngageDivisions } = require('./lectureEngage');
const { upsert, idOf, sleep } = require('../writers/base44-writer');
const { trouverProjet } = require('./pousseurTransactions');

async function syncEngageControle(code, ctx, opts) {
  const dryRun = !(opts && opts.dryRun === false);
  const projet = trouverProjet(ctx.projets, code);
  if (!projet) return { ok: false, projet: code, error: 'Projet absent de Manœuvre' };
  const projetId = idOf(projet);

  const eng = await lireEngageDivisions(code);
  if (!eng.ok) return eng;

  const existing = {};
  (ctx.divisions || []).filter(x => x.projet_id === projetId).forEach(x => {
    if (x.code_division != null) existing[String(x.code_division).trim()] = x;
  });

  const diffs = [], sans_ligne_budget = [];
  let mis_a_jour = 0, inchange = 0, erreurs = 0;
  for (const d of eng.divisions) {
    const cd = String(d.code_division).trim();
    const ex = existing[cd];
    if (!ex) { sans_ligne_budget.push({ code_division: cd, engage: d.engage_ouvert }); continue; }
    const avant = Math.round(Number(ex.engage || 0) * 100) / 100;
    const apres = d.engage_ouvert;
    if (Math.abs(avant - apres) < 0.01) { inchange++; continue; }
    diffs.push({ code_division: cd, avant, apres, delta: Math.round((apres - avant) * 100) / 100 });
    if (!dryRun) {
      const r = await upsert('ControleBudgetaire', idOf(ex), { engage: apres, sync_avantage_ts: new Date().toISOString() });
      if (r.ok) mis_a_jour++; else erreurs++;
      await sleep(60);
    }
  }

  return {
    ok: true, projet: code, projet_id: projetId, dry_run: dryRun,
    total_ouvert: eng.total_ouvert, divisions_avantage: eng.divisions.length,
    a_modifier: diffs.length, inchange, mis_a_jour: dryRun ? 0 : mis_a_jour, erreurs,
    diffs, sans_ligne_budget,
  };
}

module.exports = { syncEngageControle };
