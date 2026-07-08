const express = require('express');
const router = express.Router();
const { api, sleep } = require('../writers/base44-writer');
const { lireTable } = require('../datasources/avantage');

const MO_CODES = ['06101'];

function getKey(keys, ...fragments) {
  return keys.find(k => fragments.some(f => k.toLowerCase().includes(f.toLowerCase())));
}

// P26010, 26010, 0000026010 → "26010" (comparaison stricte, pas de includes)
function normaliserCode(c) {
  return String(c || '').toUpperCase().trim().replace(/^P/, '').replace(/^0+/, '');
}

router.post('/sync/:code', async (req, res) => {
  const code = req.params.code.replace(/^P/i, '').trim();
  const paddedCode = code.padStart(10, '0');

  // ACTIVE — [0]=numéro activité [1]=description française
  const actMap = {};
  (await lireTable('ACTIVE')).lignes.forEach(r => {
    const codeAct = (r[0] || '').replace(/\.00$/, '');
    if (codeAct) actMap[codeAct] = r[1] || codeAct;
  });

  const conpre = await lireTable('CONPRE');
  if (!conpre.objets.length) return res.json({ error: 'CONPRE vide ou introuvable (source: ' + conpre.source + ')' });
  const preRows = conpre.objets;
  const preKeys = conpre.colonnes;
  const kProjet   = getKey(preKeys, 'projet', 'CPCONUM');
  const kActivite = getKey(preKeys, 'activit', 'CPACT');
  const kMontant  = getKey(preKeys, 'visionnel', 'Montant', 'CPMNT');

  const conprePhases = preRows.filter(r => {
    const num = (r[kProjet] || '').trim();
    return num === paddedCode || parseInt(num, 10) === parseInt(code, 10);
  });

  // CONACT — [0]=projet [1]=activite [2]=pct [3]=depense_a_venir [4]=facture_a_date (revenus client)
  const factureMap = {};
  (await lireTable('CONACT')).lignes
    .filter(r => parseInt((r[0]||'').trim(), 10) === parseInt(code, 10))
    .forEach(r => {
      const act = (r[1] || '').trim().replace(/\.00$/, '');
      const facture = parseFloat((r[4] || '0').replace(',', '.')) || 0;
      if (act) factureMap[act] = (factureMap[act] || 0) + facture;
    });

  // TRANS — source unique des depenses reelles
  // R=comptes-clients (revenus) EXCLU, P/E/B inclus
  const transMap = {};
  (await lireTable('TRANS')).lignes
    .filter(r => {
      if (parseInt((r[0]||'').trim(), 10) !== parseInt(code, 10)) return false;
      const type = (r[3]||'').trim().charAt(0);
      return type !== 'R';
    })
    .forEach(r => {
      const act = (r[5] || '').trim().replace(/\.00$/, '');
      const montant = parseFloat((r[4] || '0').replace(',', '.')) || 0;
      if (act) transMap[act] = (transMap[act] || 0) + montant;
    });

  const codesConpre = new Set(conprePhases.map(r => (r[kActivite]||'').trim().replace(/\.00$/, '')));
  const phasesExtra = Object.keys(transMap)
    .filter(act => !codesConpre.has(act) && transMap[act] > 0 && act.trim() !== '')
    .map(act => ({ _from_trans: true, _act: act }));

  // Dedup intra-execution : un projet present en format padde ET court dans
  // CONPRE passait deux fois le filtre → chaque division creee en double.
  const vues = new Set();
  const allPhases = [...conprePhases, ...phasesExtra].filter(ph => {
    const act = ph._from_trans ? ph._act : (ph[kActivite] || '').trim().replace(/\.00$/, '');
    if (!act || vues.has(act)) return false;
    vues.add(act);
    return true;
  });
  if (!allPhases.length) {
    const sample = [...new Set(preRows.slice(0, 5).map(r => r[kProjet]))];
    return res.json({ error: 'Projet ' + code + ' non trouve', sample });
  }

  const pRes = await api('GET', '/entities/Projet?limit=500');
  let projets = [];
  try { const d = JSON.parse(pRes.data); projets = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  // Match STRICT (l'ancien includes() pouvait rattacher le mauvais projet)
  const matches = projets.filter(p => normaliserCode(p.code_projet) === normaliserCode(code));
  const projet = matches[0];
  if (!projet) return res.json({ error: 'Projet ' + code + ' non trouve dans Base44' });
  const avertissements = [];
  if (matches.length > 1) {
    avertissements.push('Fiches Projet en double dans Base44 pour ' + code + ' : '
      + matches.map(p => p._id || p.id).join(', ') + ' — sync sous la premiere, dedoublonner l\'entite Projet.');
  }
  const projetId = projet._id || projet.id;

  // Lecture des existants FILTREE par projet (l'ancien GET limit=500 global
  // ratait les lignes du projet des que l'entite depassait 500 enregistrements,
  // et tout etait recree en double au sync suivant).
  const cbRes = await api('GET', '/entities/ControleBudgetaire?projet_id=' + encodeURIComponent(projetId) + '&limit=1000');
  let existing = [];
  try { const d = JSON.parse(cbRes.data); existing = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  existing = existing.filter(x => x.projet_id === projetId);

  // Miroir Avantage 1/2 : si des doublons existent deja, garder la premiere
  // ligne de chaque division et supprimer les autres.
  const existingMap = {};
  let deleted_doublons = 0;
  for (const x of existing) {
    const id = x._id || x.id;
    if (existingMap[x.code_division]) {
      const r = await api('DELETE', '/entities/ControleBudgetaire/' + id);
      if (r.status === 200 || r.status === 204) deleted_doublons++;
      await sleep(100);
    } else {
      existingMap[x.code_division] = id;
    }
  }

  let created = 0, updated = 0, errors = 0;
  for (const ph of allPhases) {
    const code_act = ph._from_trans ? ph._act : (ph[kActivite] || '').trim().replace(/\.00$/, '');
    const isMO = MO_CODES.includes(code_act);
    const nom = actMap[code_act] || code_act;
    const budget = ph._from_trans ? 0 : parseFloat((ph[kMontant] || '0').replace(',', '.')) || 0;
    const engage = isMO ? 0 : (transMap[code_act] || 0);
    const mo_total = isMO ? (transMap[code_act] || 0) : 0;
    const facture = factureMap[code_act] || 0;

    const div = {
      projet_id: projetId, code_division: code_act, nom_division: nom,
      montant_initial: budget, montant_revise: 0, engage, mo_total,
      prevision_total: 0,
      facture: facture,
      recup_pertes: parseFloat((engage + mo_total - budget).toFixed(2)),
      pourcentage: budget > 0 ? parseFloat(((engage + mo_total) / budget * 100).toFixed(2)) : 0,
      directives_travaux: 0, travaux_crc: 0, credit_admin: 0, asse_caut: 0, decompte_crc: 0,
    };
    const existingId = existingMap[code_act];
    let st = 429, data = '';
    while (st === 429) {
      const r = existingId
        ? await api('PUT', '/entities/ControleBudgetaire/' + existingId, div)
        : await api('POST', '/entities/ControleBudgetaire', div);
      st = r.status; data = r.data;
      if (st === 429) await sleep(1500);
    }
    if (st === 200 || st === 201) {
      if (existingId) { updated++; }
      else {
        created++;
        // Enregistrer l'id cree : si la meme division repassait dans la boucle,
        // elle serait mise a jour au lieu d'etre creee une deuxieme fois.
        try { existingMap[code_act] = JSON.parse(data)._id || JSON.parse(data).id; } catch (e) { existingMap[code_act] = true; }
      }
    } else errors++;
    await sleep(150);
  }

  // Miroir Avantage 2/2 : supprimer les divisions qui n'existent plus dans
  // l'export (l'objectif est que Base44 reflete exactement Avantage).
  let deleted_orphelins = 0;
  for (const [code_div, id] of Object.entries(existingMap)) {
    if (vues.has(code_div) || typeof id !== 'string') continue;
    const r = await api('DELETE', '/entities/ControleBudgetaire/' + id);
    if (r.status === 200 || r.status === 204) deleted_orphelins++;
    await sleep(100);
  }

  res.json({
    ok: true, projet: code, projet_id: projetId, phases: allPhases.length,
    created, updated, deleted_doublons, deleted_orphelins, errors,
    ...(avertissements.length ? { avertissements } : {}),
  });
});

module.exports = router;