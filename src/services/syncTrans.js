const { upsert, idOf, sleep } = require('../writers/base44-writer');
const { rowsFor } = require('./dataset');
const { findProjet, indexBy } = require('./snapshot');

// GL de taxes a exclure du montant net
const GL_TAXES = ['21340', '21370', '21310', '21300'];

// Montant net d'une ligne PYBBIL (taxes exclues).
// GL paires: col[8]/col[9], col[10]/col[11], ..., col[26]/col[27]
function getMontantNet(r) {
  let total = 0;
  for (let i = 0; i <= 9; i++) {
    const gl = (r[8 + i * 2] || '').trim();
    const mt = parseFloat(r[9 + i * 2]) || 0;
    if (gl && !GL_TAXES.includes(gl)) total += mt;
  }
  return total !== 0 ? total : parseFloat(r[6]) || 0;
}

// Pousse le detail des transactions (factures fournisseurs PYBBIL + ecritures TRANS E/B).
// divMap / bcMap viennent des syncs budget et BC pour rattacher chaque transaction.
async function syncTrans(codeRaw, ds, snap, opts) {
  const code = codeRaw.replace(/^P/i, '').trim();
  const divisionFilter = (opts && opts.division) || null;

  const projet = findProjet(snap.Projet, code);
  if (!projet) return { ok: false, projet: code, error: 'Projet ' + code + ' non trouve dans Base44' };
  const projetId = idOf(projet);

  const divMap = (opts && opts.divMap) || indexBy(snap.ControleBudgetaire, projetId, 'code_division');
  let bcMap = opts && opts.bcMap;
  if (!bcMap) {
    bcMap = {};
    snap.BonDeCommande.filter(x => x.projet_id === projetId).forEach(x => {
      if (x.reference_avantage) bcMap[String(x.reference_avantage).padStart(9, '0')] = idOf(x);
    });
  }

  const existingMap = indexBy(snap.TransactionAvantage, projetId, 'numero_journal');

  const toUpsert = [];

  // PYBBIL — factures fournisseurs, montant NET (sans taxes)
  // [0]=Num seq [1]=Date [4]=Num facture [5]=Description [6]=Montant total
  // [33]=Num projet [44]=No. de commande [48]=Nom fournisseur
  const pybbilRows = rowsFor(ds.index.pybbil, code);
  for (const r of pybbilRows) {
    const numSeq = 'P' + (r[0] || '').trim();
    const numCommandeRaw = (r[44] || '').trim();
    const numCommande = numCommandeRaw ? numCommandeRaw.padStart(9, '0') : '';
    const numFacture = (r[4] || '').trim();
    const codeDivision = numCommande ? (ds.commandeDivMap[numCommande] || '') : '';
    if (divisionFilter && codeDivision !== divisionFilter) continue;

    toUpsert.push({
      projet_id: projetId,
      controle_budgetaire_id: codeDivision ? (divMap[codeDivision] || null) : null,
      bon_de_commande_id: numCommande ? (bcMap[numCommande] || null) : null,
      code_division: codeDivision,
      date_transaction: (r[1] || '').replace(/\//g, '-'),
      numero_journal: numSeq,
      numero_facture: numFacture,
      fournisseur: (r[48] || '').trim(),
      description: (r[5] || numFacture || '').trim(),
      montant: getMontantNet(r),
      type_transaction: 'P',
      numero_gl: '33200',
      is_mo: false,
      numero_commande_avantage: numCommande,
      sync_avantage_ts: new Date().toISOString(),
    });
  }

  // TRANS types E (masse salariale) et B (banque)
  const transRows = rowsFor(ds.index.trans, code).filter(r => {
    const type = (r[3] || '').trim().charAt(0);
    if (type !== 'E' && type !== 'B') return false;
    if (divisionFilter && (r[5] || '').trim().replace(/\.00$/, '') !== divisionFilter) return false;
    return true;
  });
  for (const r of transRows) {
    const type = (r[3] || '').trim().charAt(0);
    const codeActivite = (r[5] || '').trim().replace(/\.00$/, '');
    toUpsert.push({
      projet_id: projetId,
      controle_budgetaire_id: divMap[codeActivite] || null,
      bon_de_commande_id: null,
      code_division: codeActivite,
      date_transaction: (r[2] || '').trim().replace(/\//g, '-'),
      numero_journal: (r[3] || '').trim(),
      numero_facture: '',
      fournisseur: type === 'E' ? 'Masse salariale' : 'Banque',
      description: type === 'E' ? 'Ecriture salariale' : 'Transaction bancaire',
      montant: parseFloat((r[4] || '0').replace(',', '.')) || 0,
      type_transaction: type,
      numero_gl: (r[1] || '').trim(),
      is_mo: type === 'E',
      numero_commande_avantage: '',
      sync_avantage_ts: new Date().toISOString(),
    });
  }

  // Un meme numero de journal peut porter plusieurs lignes (une par activite).
  // Sans cle distincte, chaque ligne ecrasait la precedente et le detail etait perdu.
  const vus = new Map();
  for (const t of toUpsert) {
    const base = t.numero_journal || 'SANS-JOURNAL';
    const n = (vus.get(base) || 0) + 1;
    vus.set(base, n);
    if (n > 1) t.numero_journal = base + '-' + (t.code_division || n);
  }

  let created = 0, updated = 0, errors = 0;
  for (const payload of toUpsert) {
    const existingId = existingMap[payload.numero_journal];
    const r = await upsert('TransactionAvantage', existingId || null, payload);
    if (r.ok) { existingId ? updated++ : created++; } else errors++;
    await sleep(50);
  }

  return { ok: true, projet: code, projet_id: projetId, division: divisionFilter || 'toutes', total: toUpsert.length, created, updated, errors };
}

module.exports = { syncTrans, getMontantNet };
