// Construit les index de travail a partir des lignes canoniques fournies par
// la source Avantage (BD ODBC ou export Excel) — meme structure dans les deux cas.

// Index des lignes par numero de projet. Evite de balayer 180 000 transactions
// une fois par projet lors d'un sync multi-projets.
function indexByProjet(rows, champ) {
  const map = new Map();
  for (const r of rows) {
    const raw = (r[champ] == null ? '' : String(r[champ])).trim();
    if (!raw) continue;
    const n = parseInt(raw, 10);
    const key = Number.isFinite(n) ? String(n) : raw;
    let bucket = map.get(key);
    if (!bucket) { bucket = []; map.set(key, bucket); }
    bucket.push(r);
  }
  return map;
}

// Lignes d'un projet donne, quel que soit le zero-padding du numero.
function rowsFor(index, code) {
  const c = String(code).replace(/^P/i, '').trim();
  const n = parseInt(c, 10);
  return (Number.isFinite(n) ? index.get(String(n)) : null) || index.get(c) || [];
}

function buildDataset(detail) {
  const actMap = {};
  for (const a of detail.activites) if (a.code) actMap[a.code] = a.nom || a.code;

  // Premiere activite rencontree pour un bon de commande donne.
  const commandeDivMap = {};
  for (const it of detail.commandeItems) {
    const cmd = (it.no_commande || '').padStart(9, '0');
    if (cmd && cmd !== '000000000' && it.activite && !commandeDivMap[cmd]) commandeDivMap[cmd] = it.activite;
  }

  return {
    source: detail.source,
    lu_a: detail.lu_a,
    age_heures: detail.age_heures,
    colonnes_manquantes: detail.colonnes_manquantes || {},
    actMap,
    commandeDivMap,
    compte: {
      activites: detail.activites.length,
      budget: detail.budget.length,
      facturation: detail.facturationActivite.length,
      transactions: detail.transactions.length,
      factures_fournisseur: detail.facturesFournisseur.length,
      commandes: detail.commandes.length,
    },
    index: {
      budget: indexByProjet(detail.budget, 'projet'),
      facturation: indexByProjet(detail.facturationActivite, 'projet'),
      transactions: indexByProjet(detail.transactions, 'projet'),
      facturesFournisseur: indexByProjet(detail.facturesFournisseur, 'projet'),
      commandes: indexByProjet(detail.commandes, 'projet'),
    },
  };
}

module.exports = { buildDataset, rowsFor, indexByProjet };
