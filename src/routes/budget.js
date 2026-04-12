const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { api, sleep } = require('../writers/base44-writer');
const { parseActive } = require('../parsers/parseActive');

const EXPORT_DIR = path.resolve(__dirname, '../../exports-avantage');
const MO_CODES = ['06101'];

function getKey(keys, ...fragments) {
  return keys.find(k => fragments.some(f => k.toLowerCase().includes(f.toLowerCase())));
}

router.post('/sync/:code', async (req, res) => {
  const code = req.params.code.replace(/^P/i, '').trim();
  const paddedCode = code.padStart(10, '0');

  const actMap = {};
  const actPath = path.join(EXPORT_DIR, 'ACTIVE.csv');
  if (fs.existsSync(actPath)) {
    const content = fs.readFileSync(actPath, 'latin1');
    Object.assign(actMap, parseActive(content));
  }

  const prePath = path.join(EXPORT_DIR, 'CONPRE.csv');
  if (!fs.existsSync(prePath)) return res.json({ error: 'CONPRE.csv introuvable' });
  const preContent = fs.readFileSync(prePath, 'latin1');
  const preRows = parse(preContent, { columns: true, skip_empty_lines: true, trim: true });
  if (!preRows.length) return res.json({ error: 'CONPRE.csv vide' });
  const preKeys = Object.keys(preRows[0]);
  const kProjet   = getKey(preKeys, 'projet', 'CPCONUM');
  const kActivite = getKey(preKeys, 'activit', 'CPACT');
  const kMontant  = getKey(preKeys, 'visionnel', 'Montant', 'CPMNT');

  const conprePhases = preRows.filter(r => {
    const num = (r[kProjet] || '').trim();
    return num === paddedCode || parseInt(num, 10) === parseInt(code, 10);
  });

  // CONACT — [0]=projet [1]=activite [2]=pct [3]=depense_a_venir [4]=facture_a_date (revenus client)
  const factureMap = {};
  const conactPath = path.join(EXPORT_DIR, 'CONACT.csv');
  if (fs.existsSync(conactPath)) {
    const conactContent = fs.readFileSync(conactPath, 'latin1');
    const conactRows = parse(conactContent, { columns: false, skip_empty_lines: true, trim: true, from_line: 2 });
    conactRows
      .filter(r => parseInt((r[0]||'').trim(), 10) === parseInt(code, 10))
      .forEach(r => {
        const act = (r[1] || '').trim().replace(/\.00$/, '');
        const facture = parseFloat((r[4] || '0').replace(',', '.')) || 0;
        if (act) factureMap[act] = (factureMap[act] || 0) + facture;
      });
  }

  // TRANS — source unique des depenses reelles
  // R=comptes-clients (revenus) EXCLU, P/E/B inclus
  const transMap = {};
  const transPath = path.join(EXPORT_DIR, 'TRANS.csv');
  if (fs.existsSync(transPath)) {
    const transContent = fs.readFileSync(transPath, 'latin1');
    const transRows = parse(transContent, { columns: false, skip_empty_lines: true, trim: true, from_line: 2 });
    transRows
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
  }

  const codesConpre = new Set(conprePhases.map(r => (r[kActivite]||'').trim().replace(/\.00$/, '')));
  const phasesExtra = Object.keys(transMap)
    .filter(act => !codesConpre.has(act) && transMap[act] > 0 && act.trim() !== '')
    .map(act => ({ _from_trans: true, _act: act }));

  const allPhases = [...conprePhases, ...phasesExtra];
  if (!allPhases.length) {
    const sample = [...new Set(preRows.slice(0, 5).map(r => r[kProjet]))];
    return res.json({ error: 'Projet ' + code + ' non trouve', sample });
  }

  const pRes = await api('GET', '/entities/Projet?limit=500');
  let projets = [];
  try { const d = JSON.parse(pRes.data); projets = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const projet = projets.find(p => {
    const cp = (p.code_projet || '').toUpperCase();
    return cp === 'P' + code || cp.includes(code) || cp === code;
  });
  if (!projet) return res.json({ error: 'Projet ' + code + ' non trouve dans Base44' });

  const cbRes = await api('GET', '/entities/ControleBudgetaire?limit=500');
  let existing = [];
  try { const d = JSON.parse(cbRes.data); existing = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const existingMap = {};
  const projetId = projet._id || projet.id;
  existing.filter(x => x.projet_id === projetId).forEach(x => {
    existingMap[x.code_division] = x._id || x.id;
  });

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
    let st = 429;
    while (st === 429) {
      const r = existingId
        ? await api('PUT', '/entities/ControleBudgetaire/' + existingId, div)
        : await api('POST', '/entities/ControleBudgetaire', div);
      st = r.status;
      if (st === 429) await sleep(1500);
    }
    if (st === 200 || st === 201) { existingId ? updated++ : created++; } else errors++;
    await sleep(150);
  }
  res.json({ ok: true, projet: code, projet_id: projetId, phases: allPhases.length, created, updated, errors });
});

module.exports = router;