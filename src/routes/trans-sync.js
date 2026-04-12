const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { api, sleep } = require('../writers/base44-writer');

const EXPORT_DIR = path.resolve(__dirname, '../../exports-avantage');

// GL de taxes a exclure du montant net
const GL_TAXES = ['21340', '21370', '21310', '21300'];

// Extraire le montant net d'une ligne PYBBIL (exclure taxes)
// GL paires: col[8]/col[9], col[10]/col[11], ..., col[26]/col[27]
function getMontantNet(r) {
  let total = 0;
  for (let i = 0; i <= 9; i++) {
    const gl = (r[8 + i * 2] || '').trim();
    const mt = parseFloat(r[9 + i * 2]) || 0;
    if (gl && !GL_TAXES.includes(gl)) total += mt;
  }
  // Si total net est 0, fallback sur montant total
  return total !== 0 ? total : parseFloat(r[6]) || 0;
}

// PYBBIL colonnes par position:
// [0]=Num seq [1]=Date [2]=Num fournisseur [4]=Num facture [5]=Description
// [6]=Montant total [33]=Num projet [44]=No. de commande [48]=Nom fournisseur
function readPybbil(code) {
  const pybbilPath = path.join(EXPORT_DIR, 'PYBBIL.csv');
  if (!fs.existsSync(pybbilPath)) return [];
  const content = fs.readFileSync(pybbilPath, 'latin1');
  const rows = parse(content, { columns: false, skip_empty_lines: true, trim: true, from_line: 2 });
  return rows.filter(r => parseInt((r[33]||'').trim(), 10) === parseInt(code, 10));
}

// COMITE [16]=Num seq commande [17]=Code activite
function buildCommandeDivisionMap() {
  const comitePath = path.join(EXPORT_DIR, 'COMITE.csv');
  if (!fs.existsSync(comitePath)) return {};
  const content = fs.readFileSync(comitePath, 'latin1');
  const rows = parse(content, { columns: false, skip_empty_lines: true, trim: true, from_line: 2 });
  const map = {};
  for (const r of rows) {
    const cmd = (r[16] || '').trim().padStart(9, '0');
    const act = (r[17] || '').trim().replace(/\.00$/, '');
    if (cmd && cmd !== '000000000' && act && !map[cmd]) map[cmd] = act;
  }
  return map;
}

router.post('/sync-trans/:code', async (req, res) => {
  const code = req.params.code.replace(/^P/i, '').trim();
  const divisionFilter = req.query.division || null;

  const pRes = await api('GET', '/entities/Projet?limit=500');
  let projets = [];
  try { const d = JSON.parse(pRes.data); projets = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const projet = projets.find(p => {
    const cp = (p.code_projet || '').toUpperCase();
    return cp === 'P' + code || cp.includes(code) || cp === code;
  });
  if (!projet) return res.json({ error: 'Projet ' + code + ' non trouve' });
  const projetId = projet._id || projet.id;

  const cbRes = await api('GET', '/entities/ControleBudgetaire?limit=500');
  let divisions = [];
  try { const d = JSON.parse(cbRes.data); divisions = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const divMap = {};
  divisions.filter(x => x.projet_id === projetId).forEach(x => { divMap[x.code_division] = x._id || x.id; });

  const bcRes = await api('GET', '/entities/BonDeCommande?limit=500');
  let bcs = [];
  try { const d = JSON.parse(bcRes.data); bcs = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const bcMap = {};
  bcs.filter(x => x.projet_id === projetId).forEach(x => {
    if (x.reference_avantage) bcMap[x.reference_avantage.padStart(9, '0')] = x._id || x.id;
  });

  let existingTrans = [];
  const trRes = await api('GET', '/entities/TransactionAvantage?limit=500');
  try { const d = JSON.parse(trRes.data); const arr = Array.isArray(d) ? d : (d.items || []); existingTrans = arr.filter(x => x.projet_id === projetId); } catch (e) {}
  const existingMap = {};
  existingTrans.forEach(x => { if (x.numero_journal) existingMap[x.numero_journal] = x._id || x.id; });

  const commandeDivMap = buildCommandeDivisionMap();
  const toUpsert = [];

  // PYBBIL — montant NET (sans taxes)
  const pybbilRows = readPybbil(code);
  console.log('[INFO] PYBBIL P' + code + ':', pybbilRows.length);
  for (const r of pybbilRows) {
    const numSeq = 'P' + (r[0] || '').trim();
    const numCommandeRaw = (r[44] || '').trim();
    const numCommande = numCommandeRaw ? numCommandeRaw.padStart(9, '0') : '';
    const fournisseur = (r[48] || '').trim();
    const numFacture = (r[4] || '').trim();
    const description = (r[5] || numFacture || '').trim();
    const montant = getMontantNet(r);
    const dateRaw = (r[1] || '').replace(/\//g, '-');
    const bcId = numCommande ? (bcMap[numCommande] || null) : null;
    const codeDivision = numCommande ? (commandeDivMap[numCommande] || '') : '';
    const divisionId = codeDivision ? (divMap[codeDivision] || null) : null;

    if (divisionFilter && codeDivision !== divisionFilter) continue;

    toUpsert.push({
      projet_id: projetId,
      controle_budgetaire_id: divisionId,
      bon_de_commande_id: bcId,
      code_division: codeDivision,
      date_transaction: dateRaw,
      numero_journal: numSeq,
      numero_facture: numFacture,
      fournisseur: fournisseur,
      description: description,
      montant: montant,
      type_transaction: 'P',
      numero_gl: '33200',
      is_mo: false,
      numero_commande_avantage: numCommande,
      sync_avantage_ts: new Date().toISOString(),
    });
  }

  // TRANS type E et B
  const transPath = path.join(EXPORT_DIR, 'TRANS.csv');
  if (fs.existsSync(transPath)) {
    const transContent = fs.readFileSync(transPath, 'latin1');
    const transRows = parse(transContent, { columns: false, skip_empty_lines: true, trim: true, from_line: 2 });
    const filtered = transRows.filter(r => {
      if (parseInt((r[0]||'').trim(), 10) !== parseInt(code, 10)) return false;
      const type = (r[3]||'').trim().charAt(0);
      if (type !== 'E' && type !== 'B') return false;
      const act = (r[5] || '').trim().replace(/\.00$/, '');
      if (divisionFilter && act !== divisionFilter) return false;
      return true;
    });
    for (const r of filtered) {
      const type = (r[3]||'').trim().charAt(0);
      const codeActivite = (r[5] || '').trim().replace(/\.00$/, '');
      const numeroJournal = (r[3]||'').trim();
      const montant = parseFloat((r[4]||'0').replace(',', '.')) || 0;
      const dateStr = (r[2]||'').trim().replace(/\//g, '-');
      const numeroGL = (r[1]||'').trim();
      const divisionId = divMap[codeActivite] || null;
      toUpsert.push({
        projet_id: projetId, controle_budgetaire_id: divisionId, bon_de_commande_id: null,
        code_division: codeActivite, date_transaction: dateStr, numero_journal: numeroJournal,
        numero_facture: '', fournisseur: type === 'E' ? 'Masse salariale' : 'Banque',
        description: type === 'E' ? 'Ecriture salariale' : 'Transaction bancaire',
        montant: montant, type_transaction: type, numero_gl: numeroGL, is_mo: type === 'E',
        numero_commande_avantage: '', sync_avantage_ts: new Date().toISOString(),
      });
    }
  }

  console.log('[INFO] Total a pousser:', toUpsert.length);

  let created = 0, updated = 0, errors = 0;
  for (const payload of toUpsert) {
    const existingId = existingMap[payload.numero_journal];
    let st = 429;
    while (st === 429) {
      const resp = existingId
        ? await api('PUT', '/entities/TransactionAvantage/' + existingId, payload)
        : await api('POST', '/entities/TransactionAvantage', payload);
      st = resp.status;
      if (st === 429) await sleep(1500);
    }
    if (st === 200 || st === 201) { existingId ? updated++ : created++; } else errors++;
    await sleep(50);
  }

  res.json({ ok: true, projet: code, division: divisionFilter || 'toutes', total: toUpsert.length, created, updated, errors });
});

module.exports = router;