const { parse } = require('csv-parse/sync');

function parseFactma(csvContent) {
  const records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
  return records.map(r => ({
    numero_facture: (r.FFNOFACT || '').trim(),
    numero_projet: (r.FFCONT || '').trim(),
    client_nom: (r.FFVENTE || r.FFNOM || '').trim(),
    date_facture: (r.FFDATE || '').trim(),
    date_echeance: (r.FFDATEP || '').trim(),
    total_facture: parseFloat((r.FFTOTDU || '0').replace(',', '.')) || 0,
    solde_ouvert: parseFloat((r.FFSOLDE || '0').replace(',', '.')) || 0,
    retenue_total: parseFloat((r.FFMNTRET || '0').replace(',', '.')) || 0,
    statut_paiement: parseFloat((r.FFSOLDE || '0').replace(',', '.')) > 0 ? 'ouvert' : 'payé',
    _source: 'FACTMA',
  }));
}

module.exports = { parseFactma };
