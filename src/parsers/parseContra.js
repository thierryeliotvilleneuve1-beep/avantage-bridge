// records : lignes en objets clés par nom de colonne Avantage
// (fournies par datasources/avantage.js — DB ou CSV)
function parseContra(records) {
  return records.map(r => ({
    numero_projet: (r.CONUM || '').trim(),
    nom_projet: (r.CONOM || r.CONOMS || '').trim(),
    client_nom: (r.COCLINOM || r.COCLI || '').trim(),
    statut: (r.COSTT || '').trim(),
    date_debut: (r.COFADATER || '').trim(),
    date_fin_prevue: (r.COFADATEP || '').trim(),
    budget_prevu: parseFloat((r.COSOLDER || '0').replace(',', '.')) || 0,
    cout_reel: parseFloat((r.COPRCPROF || '0').replace(',', '.')) || 0,
    _source: 'CONTRA',
  }));
}

module.exports = { parseContra };
