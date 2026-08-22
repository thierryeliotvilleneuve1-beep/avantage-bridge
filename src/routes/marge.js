const express = require('express');
const router = express.Router();
const { construireProjet } = require('../lib/controle-budgetaire');
const { listerProjets } = require('../lib/sources');

/**
 * Vue portefeuille — lecture seule.
 *
 * C'est l'ecran de revue de marge du lundi : tous les projets tries par marge
 * projetee croissante, le plus expose en premier. Les projets dont le revenu
 * contractuel est inconnu sont regroupes a part plutot que classes a 0 % :
 * une marge inconnue n'est pas une marge nulle.
 */
router.get('/', (req, res) => {
  const methode = req.query.methode === 'engagement' ? 'engagement' : 'budget';
  const limite = Math.min(parseInt(req.query.limit, 10) || 200, 500);

  const { disponible, codes, source, maj } = listerProjets();
  if (!disponible) {
    return res.status(503).json({
      error: 'CONPRE.csv introuvable — impossible de lister les projets.',
      source,
    });
  }

  const mesures = [];
  const sansRevenu = [];
  const erreurs = [];

  for (const code of codes.slice(0, limite)) {
    let projet;
    try {
      projet = construireProjet(code, { methode });
    } catch (e) {
      erreurs.push({ projet: code, erreur: e.message });
      continue;
    }
    if (!projet.divisions.length) continue;
    const ligne = {
      projet: 'P' + code.padStart(5, '0'),
      code,
      budget_revenus: projet.rollup.budget_revenus,
      montant_revise: projet.rollup.montant_revise,
      cout_reel: projet.rollup.cout_reel,
      cout_engage: projet.rollup.cout_engage,
      prevision_total: projet.rollup.prevision_total,
      marge_projetee: projet.rollup.marge_projetee,
      marge_projetee_pct: projet.rollup.marge_projetee_pct,
      ecart_budget_pct: projet.rollup.ecart_budget_pct,
      statut: projet.rollup.statut,
      marge_partielle: projet.rollup.marge_partielle,
      nb_divisions: projet.rollup.nb_divisions,
    };
    (ligne.marge_projetee === null ? sansRevenu : mesures).push(ligne);
  }

  mesures.sort((a, b) => a.marge_projetee_pct - b.marge_projetee_pct);

  const revenusTotal = mesures.reduce((a, x) => a + x.budget_revenus, 0);
  const previsionTotal = mesures.reduce((a, x) => a + x.prevision_total, 0);

  res.json({
    ok: true,
    methode,
    source_liste: source,
    maj_source: maj || null,
    portefeuille: {
      projets_mesures: mesures.length,
      projets_sans_revenu_connu: sansRevenu.length,
      budget_revenus: Math.round(revenusTotal * 100) / 100,
      prevision_total: Math.round(previsionTotal * 100) / 100,
      marge_projetee: Math.round((revenusTotal - previsionTotal) * 100) / 100,
      marge_projetee_pct: revenusTotal > 0
        ? Math.round(((revenusTotal - previsionTotal) / revenusTotal) * 10000) / 100
        : null,
      sous_10_pct: mesures.filter((x) => x.marge_projetee_pct < 10).length,
      sous_20_pct: mesures.filter((x) => x.marge_projetee_pct < 20).length,
      negatifs: mesures.filter((x) => x.marge_projetee_pct < 0).length,
    },
    projets: mesures,
    projets_sans_revenu_connu: sansRevenu,
    erreurs: erreurs.length ? erreurs : undefined,
  });
});

/** Detail d'un projet — lecture seule, divisions triees par marge croissante. */
router.get('/:code', (req, res) => {
  const code = req.params.code.replace(/^P/i, '').trim().replace(/^0+/, '');
  const methode = req.query.methode === 'engagement' ? 'engagement' : 'budget';

  const projet = construireProjet(code, { methode });
  if (!projet.divisions.length) {
    return res.status(404).json({
      error: 'Aucune division trouvee pour le projet ' + code,
      avertissements: projet.avertissements,
      sources: projet.sources,
    });
  }

  const divisions = [...projet.divisions].sort((a, b) => {
    if (a.marge_projetee_pct === null) return 1;
    if (b.marge_projetee_pct === null) return -1;
    return a.marge_projetee_pct - b.marge_projetee_pct;
  });

  res.json({ ok: true, methode, ...projet, divisions });
});

module.exports = router;
