const { parse } = require('csv-parse/sync');

function parseConpre(csvContent) {
  const records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
  if (!records.length) return [];
  const keys = Object.keys(records[0]);
  const kProjet  = keys.find(k => k.includes('projet') || k.includes('rojet'));
  const kActivite = keys.find(k => k.includes('activit') || k.includes('ctivit'));
  const kMontant  = keys.find(k => k.includes('visionnel') || k.includes('Montant'));
  return records.map(r => ({
    numero_projet:  (r[kProjet]   || '').trim(),
    code_activite:  (r[kActivite] || '').trim().replace(/\.00$/, ''),
    budget_prevu:   parseFloat((r[kMontant] || '0').replace(',', '.')) || 0,
    _source: 'CONPRE',
  }));
}

function parseConact(csvContent) {
  const records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
  return records.map(r => ({
    numero_projet:   (r['CACONUM'] || '').trim(),
    code_activite:   (r['CAANUM']  || '').trim(),
    facture_a_date:  parseFloat((r['CAFACT']  || '0').replace(',', '.')) || 0,
    depense_a_venir: parseFloat((r['CAVENIR'] || '0').replace(',', '.')) || 0,
    _source: 'CONACT',
  }));
}

module.exports = { parseConpre, parseConact };
