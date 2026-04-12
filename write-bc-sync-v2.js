const fs = require('fs');

const routeCode = `const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { api, sleep } = require('../writers/base44-writer');

const EXPORT_DIR = path.resolve(__dirname, '../../exports-avantage');

function readComman() {
  const xlsxPath = path.join(EXPORT_DIR, 'export.xlsx');
  if (!fs.existsSync(xlsxPath)) return [];
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets['COMMAN'];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

router.post('/sync-bc/:code', async (req, res) => {
  const code = req.params.code.replace(/^P/i, '').trim();
  const paddedCode = code.padStart(10, '0');

  const commanRows = readComman();
  const bcsAvantage = commanRows.filter(r => {
    const np = (r['Numero de projet'] || r['Numéro de projet'] || '').toString().trim();
    return np === paddedCode || parseInt(np, 10) === parseInt(code, 10);
  });

  if (!bcsAvantage.length) {
    return res.json({ error: 'Aucun BC trouvé dans COMMAN pour projet ' + code });
  }

  const pRes = await api('GET', '/entities/Projet?limit=500');
  let projets = [];
  try { const d = JSON.parse(pRes.data); projets = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const projet = projets.find(p => {
    const cp = (p.code_projet || '').toUpperCase();
    return cp === 'P' + code || cp.includes(code) || cp === code;
  });
  if (!projet) return res.json({ error: 'Projet ' + code + ' non trouvé dans Base44' });
  const projetId = projet._id || projet.id;

  const cbRes = await api('GET', '/entities/ControleBudgetaire?limit=500');
  let divisions = [];
  try { const d = JSON.parse(cbRes.data); divisions = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const divMap = {};
  divisions.filter(x => x.projet_id === projetId).forEach(x => { divMap[x.code_division] = x._id || x.id; });

  const bcRes = await api('GET', '/entities/BonDeCommande?limit=500');
  let existing = [];
  try { const d = JSON.parse(bcRes.data); existing = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const existingMap = {};
  existing.filter(x => x.projet_id === projetId).forEach(x => {
    if (x.reference_avantage) existingMap[x.reference_avantage] = x._id || x.id;
  });

  let created = 0, updated = 0, errors = 0;

  for (const bc of bcsAvantage) {
    const numSeq = (bc['Numero sequentiel'] || bc['Numéro séquentiel'] || '').toString().trim();
    const numSeqCommande = (bc['Numero sequentiel de commande'] || bc['Numéro séquentiel de commande'] || '').toString().trim();
    const fournisseur = (bc['Numero du fournisseur'] || bc['Numéro du fournisseur'] || '').trim();
    const nomFournisseur = (bc['Nom du fournisseur'] || fournisseur).trim();
    const montant = parseFloat(bc['Sous-total']) || 0;
    const dateRaw = (bc['Date de la reception'] || bc['Date de la réception'] || '').trim();
    const dateCommande = dateRaw.replace(/\//g, '-');
    const statut = bc['Statut de la commande (0=ouverte,1=fermee)'] === '0' ||
                   bc['Statut de la commande (0=ouverte,1=fermée)'] === '0' ? 'ouvert' : 'ferme';

    const payload = {
      projet_id: projetId,
      numero_po: 'AV-' + numSeq,
      description: nomFournisseur + (numSeqCommande ? ' (' + numSeqCommande + ')' : ''),
      montant_prevu: montant,
      reference_avantage: numSeqCommande || numSeq,
      fournisseur_avantage: fournisseur,
      statut_avantage: statut,
      sync_avantage_ts: new Date().toISOString(),
    };

    const existingId = existingMap[numSeqCommande || numSeq];
    let st = 429;
    while (st === 429) {
      const r = existingId
        ? await api('PUT', '/entities/BonDeCommande/' + existingId, payload)
        : await api('POST', '/entities/BonDeCommande', payload);
      st = r.status;
      if (st === 429) await sleep(1500);
    }
    if (st === 200 || st === 201) { existingId ? updated++ : created++; } else { console.log('BC error', st); errors++; }
    await sleep(100);
  }

  res.json({ ok: true, projet: code, bcs: bcsAvantage.length, created, updated, errors });
});

module.exports = router;`;

fs.writeFileSync('./src/routes/bc-sync.js', routeCode, 'utf8');
console.log('OK - bc-sync.js ecrit');
