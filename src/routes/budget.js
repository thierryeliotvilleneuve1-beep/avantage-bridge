const express = require('express');
const router = express.Router();
const { api, sleep } = require('../writers/base44-writer');
const { construireProjet } = require('../lib/controle-budgetaire');
const { r2 } = require('../lib/marge');

/** Retrouve le projet Manoeuvre correspondant au code Avantage. */
async function trouverProjet(code) {
  const res = await api('GET', '/entities/Projet?limit=500');
  let projets = [];
  try {
    const d = JSON.parse(res.data);
    projets = Array.isArray(d) ? d : (d.items || []);
  } catch (e) { /* reponse illisible : on retombe sur "non trouve" */ }
  return projets.find((p) => {
    const cp = (p.code_projet || '').toUpperCase();
    return cp === 'P' + code || cp.includes(code) || cp === code;
  });
}

/**
 * Somme des ODC acceptes du projet, depuis Manoeuvre.
 *
 * Limite connue et assumee : DirectiveChantier ne porte pas de code_division,
 * donc les ODC ne peuvent pas etre ventiles automatiquement par division.
 * Ils sont remontes au niveau projet, et l'appelant peut fournir une
 * ventilation manuelle via le corps de la requete ({ odc: { "16000": 25000 } }).
 */
async function chargerOdc(projetId) {
  const res = await api('GET', '/entities/DirectiveChantier?limit=500');
  let directives = [];
  try {
    const d = JSON.parse(res.data);
    directives = Array.isArray(d) ? d : (d.items || []);
  } catch (e) { return { total: 0, nb: 0, disponible: false }; }
  const acceptees = directives.filter((x) => x.projet_id === projetId && x.statut === 'odc');
  const total = acceptees.reduce(
    (a, x) => a + (Number(x.montant_odc) || Number(x.montant_total) || 0), 0,
  );
  return { total: r2(total), nb: acceptees.length, disponible: true };
}

/** Construit la charge utile ControleBudgetaire pour une division. */
function payloadDivision(projetId, d, revenusDisponibles) {
  const payload = {
    projet_id: projetId,
    code_division: d.code_division,
    nom_division: d.nom_division,
    montant_initial: d.montant_initial,
    // Ces deux champs etaient codes en dur a 0 : c'est le correctif de fond.
    montant_revise: d.montant_revise,
    prevision_total: d.prevision_total,
    // Cout reel hors main-d'oeuvre — semantique historique du champ `engage`,
    // conservee pour ne pas casser l'affichage existant de Manoeuvre.
    engage: r2(d.cout_reel - d.mo_total),
    // Engagement reel au sens du schema Manoeuvre : jamais alimente jusqu'ici.
    cout_engage: d.cout_engage,
    mo_total: d.mo_total,
    facture: d.facture,
    recup_pertes: d.recup_pertes,
    pourcentage: d.pourcentage,
  };
  // Ne jamais ecrire un 0 issu d'une source absente : cela effacerait une
  // valeur reelle saisie a la main dans Manoeuvre.
  if (revenusDisponibles) payload.budget_revenus = d.budget_revenus;
  return payload;
}

/** Apercu : calcule et retourne, sans rien ecrire dans Manoeuvre. */
router.get('/preview/:code', async (req, res) => {
  const code = req.params.code.replace(/^P/i, '').trim();
  const methode = req.query.methode === 'engagement' ? 'engagement' : 'budget';

  const projet = await trouverProjet(code);
  if (!projet) return res.status(404).json({ error: 'Projet ' + code + ' non trouve dans Manoeuvre' });
  const projetId = projet._id || projet.id;

  const odc = await chargerOdc(projetId);
  const resultat = construireProjet(code, { methode });

  res.json({
    ok: true,
    ecriture: false,
    projet: code,
    projet_id: projetId,
    odc,
    ...resultat,
  });
});

/** Synchronisation : calcule puis ecrit dans ControleBudgetaire. */
router.post('/sync/:code', async (req, res) => {
  const code = req.params.code.replace(/^P/i, '').trim();
  const methode = req.query.methode === 'engagement' ? 'engagement' : 'budget';
  const odcParDivision = (req.body && req.body.odc) || {};

  const projet = await trouverProjet(code);
  if (!projet) return res.status(404).json({ error: 'Projet ' + code + ' non trouve dans Manoeuvre' });
  const projetId = projet._id || projet.id;

  const resultat = construireProjet(code, { odcParDivision, methode });
  if (!resultat.divisions.length) {
    return res.status(404).json({
      error: 'Aucune division trouvee pour le projet ' + code,
      avertissements: resultat.avertissements,
      sources: resultat.sources,
    });
  }

  const odc = await chargerOdc(projetId);
  const odcVentile = r2(Object.values(odcParDivision).reduce((a, v) => a + (Number(v) || 0), 0));
  const avertissements = [...resultat.avertissements];
  if (odc.total > 0 && odcVentile === 0) {
    avertissements.push(
      `${odc.nb} ODC totalisant ${odc.total} $ ne sont pas ventiles par division `
      + '— le budget revise par division reste egal au budget initial. '
      + 'Fournir { "odc": { "<division>": <montant> } } dans le corps de la requete pour les imputer.',
    );
  }

  const revenusDisponibles = resultat.sources.CONFIT.disponible;

  const cbRes = await api('GET', '/entities/ControleBudgetaire?limit=500');
  let existantes = [];
  try {
    const d = JSON.parse(cbRes.data);
    existantes = Array.isArray(d) ? d : (d.items || []);
  } catch (e) { /* liste vide : tout sera cree */ }
  const parDivision = {};
  existantes
    .filter((x) => x.projet_id === projetId)
    .forEach((x) => { parDivision[x.code_division] = x._id || x.id; });

  let created = 0, updated = 0, errors = 0;
  const echecs = [];

  for (const division of resultat.divisions) {
    const payload = payloadDivision(projetId, division, revenusDisponibles);
    const existantId = parDivision[division.code_division];

    let st = 429, tentatives = 0;
    let derniere = null;
    while (st === 429 && tentatives < 5) {
      derniere = existantId
        ? await api('PUT', '/entities/ControleBudgetaire/' + existantId, payload)
        : await api('POST', '/entities/ControleBudgetaire', payload);
      st = derniere.status;
      if (st === 429) { tentatives++; await sleep(1500 * tentatives); }
    }
    if (st === 200 || st === 201) {
      existantId ? updated++ : created++;
    } else {
      errors++;
      echecs.push({ division: division.code_division, statut: st, reponse: (derniere && derniere.data || '').slice(0, 200) });
    }
    await sleep(150);
  }

  res.json({
    ok: errors === 0,
    ecriture: true,
    projet: code,
    projet_id: projetId,
    methode,
    divisions: resultat.divisions.length,
    created,
    updated,
    errors,
    echecs: echecs.length ? echecs : undefined,
    budget_revenus_ecrit: revenusDisponibles,
    odc,
    rollup: resultat.rollup,
    avertissements,
    sources: resultat.sources,
  });
});

module.exports = router;
