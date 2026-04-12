const fs = require('fs');

const routeCode = `const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const { api, sleep } = require('../writers/base44-writer');

const EXPORT_DIR = path.resolve(__dirname, '../../exports-avantage');

// Lire PYBBIL depuis Excel (factures fournisseurs avec lien BC)
function readPybbil(code) {
  const xlsxPath = path.join(EXPORT_DIR, 'export.xlsx');
  if (!fs.existsSync(xlsxPath)) return [];
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets['PYBBIL'];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return rows.filter(r => {
    const np = (r['Numéro de projet'] || r['Numero de projet'] || '').toString().trim();
    return parseInt(np, 10) === parseInt(code, 10);
  });
}

router.post('/sync-trans/:code', async (req, res) => {
  const code = req.params.code.replace(/^P/i, '').trim();

  // 1. Projet Base44
  const pRes = await api('GET', '/entities/Projet?limit=500');
  let projets = [];
  try { const d = JSON.parse(pRes.data); projets = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const projet = projets.find(p => {
    const cp = (p.code_projet || '').toUpperCase();
    return cp === 'P' + code || cp.includes(code) || cp === code;
  });
  if (!projet) return res.json({ error: 'Projet ' + code + ' non trouvé dans Base44' });
  const projetId = projet._id || projet.id;

  // 2. Divisions
  const cbRes = await api('GET', '/entities/ControleBudgetaire?limit=500');
  let divisions = [];
  try { const d = JSON.parse(cbRes.data); divisions = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const divMap = {};
  divisions.filter(x => x.projet_id === projetId).forEach(x => { divMap[x.code_division] = x._id || x.id; });

  // 3. BonsDeCommande existants (pour lier les transactions P)
  const bcRes = await api('GET', '/entities/BonDeCommande?limit=500');
  let bcs = [];
  try { const d = JSON.parse(bcRes.data); bcs = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const bcMap = {}; // reference_avantage → id
  bcs.filter(x => x.projet_id === projetId).forEach(x => {
    if (x.reference_avantage) bcMap[x.reference_avantage] = x._id || x.id;
  });

  // 4. Transactions existantes
  let existingTrans = [];
  const trRes = await api('GET', '/entities/TransactionAvantage?limit=500');
  try { const d = JSON.parse(trRes.data); const arr = Array.isArray(d) ? d : (d.items || []); existingTrans = arr.filter(x => x.projet_id === projetId); } catch (e) {}
  const existingMap = {};
  existingTrans.forEach(x => { if (x.numero_journal) existingMap[x.numero_journal] = x._id || x.id; });

  const toUpsert = [];

  // 5. PYBBIL → transactions type P liées aux BCs
  const pybbilRows = readPybbil(code);
  for (const r of pybbilRows) {
    const numSeq = (r['Numéro séquentiel'] || r['Numero sequentiel'] || '').toString().trim();
    const numCommande = (r['No. de commande'] || r['No de commande'] || '').toString().trim();
    const fournisseur = (r['Nom du fournisseur'] || r['Numéro du fournisseur'] || '').trim();
    const numFacture = (r['Numéro de facture du fournisseur'] || '').trim();
    const description = (r['Description de la transaction'] || numFacture || '').trim();
    const montant = parseFloat(r['Montant total du compte']) || 0;
    const dateRaw = (r['Date du compte'] || '').replace(/\//g, '-');

    // Trouver la division depuis GL (33200 = projet, 33500 = projet)
    // On utilise le premier GL applicable au projet
    let codeDivision = '';
    for (let i = 1; i <= 10; i++) {
      const gl = (r['Numéro de G/L (' + i + ')'] || '').toString().trim();
      if (gl === '33200' || gl === '33500') {
        // On ne peut pas déduire le code activité depuis PYBBIL sans TRANS
        break;
      }
    }

    const bcId = numCommande ? (bcMap[numCommande] || null) : null;

    toUpsert.push({
      projet_id: projetId,
      controle_budgetaire_id: null, // sera mis à jour quand on aura le lien division
      bon_de_commande_id: bcId,
      code_division: codeDivision,
      date_transaction: dateRaw,
      numero_journal: 'P' + numSeq,
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

  // 6. TRANS type E et B → MO et banque
  const transPath = path.join(EXPORT_DIR, 'TRANS.csv');
  if (fs.existsSync(transPath)) {
    const transContent = fs.readFileSync(transPath, 'latin1');
    const transRows = parse(transContent, { columns: false, skip_empty_lines: true, trim: true, from_line: 2 });
    const filtered = transRows.filter(r => {
      if (parseInt((r[0]||'').trim(), 10) !== parseInt(code, 10)) return false;
      const type = (r[3]||'').trim().charAt(0);
      return type === 'E' || type === 'B';
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
        projet_id: projetId,
        controle_budgetaire_id: divisionId,
        bon_de_commande_id: null,
        code_division: codeActivite,
        date_transaction: dateStr,
        numero_journal: numeroJournal,
        numero_facture: '',
        fournisseur: type === 'E' ? 'Masse salariale' : 'Banque',
        description: type === 'E' ? 'Écriture salariale' : 'Transaction bancaire',
        montant: montant,
        type_transaction: type,
        numero_gl: numeroGL,
        is_mo: type === 'E',
        numero_commande_avantage: '',
        sync_avantage_ts: new Date().toISOString(),
      });
    }
  }

  // 7. Upsert toutes les transactions
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

  res.json({ ok: true, projet: code, total: toUpsert.length, pybbil: pybbilRows.length, created, updated, errors });
});

module.exports = router;`;

fs.writeFileSync('./src/routes/trans-sync.js', routeCode, 'utf8');
console.log('OK - trans-sync.js ecrit');
