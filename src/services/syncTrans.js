const { upsert, idOf, sleep } = require('../writers/base44-writer');
const { rowsFor } = require('./dataset');
const { findProjet, indexBy } = require('./snapshot');

// GL de taxes a exclure du montant net
const GL_TAXES = ['21340', '21370', '21310', '21300'];

// Montant net d'une facture fournisseur: somme de la ventilation hors taxes,
// avec repli sur le montant total si la ventilation est absente.
function montantNet(f) {
  let total = 0;
  for (const l of (f.ventilation || [])) if (!GL_TAXES.includes(l.gl)) total += l.montant;
  return total !== 0 ? total : (f.montant_total || 0);
}

// Pousse le detail des transactions: factures fournisseurs + ecritures de
// masse salariale (E) et bancaires (B). divMap / bcMap viennent des syncs
// budget et BC pour rattacher chaque transaction a sa division et a son BC.
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

  // Factures fournisseurs — montant NET (taxes exclues)
  for (const f of rowsFor(ds.index.facturesFournisseur, code)) {
    const numCommande = f.no_commande ? String(f.no_commande).padStart(9, '0') : '';
    const codeDivision = numCommande ? (ds.commandeDivMap[numCommande] || '') : '';
    if (divisionFilter && codeDivision !== divisionFilter) continue;

    toUpsert.push({
      projet_id: projetId,
      controle_budgetaire_id: codeDivision ? (divMap[codeDivision] || null) : null,
      bon_de_commande_id: numCommande ? (bcMap[numCommande] || null) : null,
      code_division: codeDivision,
      date_transaction: f.date,
      numero_journal: 'P' + f.seq,
      numero_facture: f.no_facture,
      fournisseur: f.fournisseur,
      description: f.description || f.no_facture,
      montant: montantNet(f),
      type_transaction: 'P',
      numero_gl: '33200',
      is_mo: false,
      numero_commande_avantage: numCommande,
      sync_avantage_ts: new Date().toISOString(),
    });
  }

  // Ecritures de grand livre: masse salariale (E) et banque (B)
  for (const t of rowsFor(ds.index.transactions, code)) {
    const type = (t.journal || '').charAt(0);
    if (type !== 'E' && type !== 'B') continue;
    if (divisionFilter && t.activite !== divisionFilter) continue;

    toUpsert.push({
      projet_id: projetId,
      controle_budgetaire_id: divMap[t.activite] || null,
      bon_de_commande_id: null,
      code_division: t.activite,
      date_transaction: t.date,
      numero_journal: t.journal,
      numero_facture: '',
      fournisseur: type === 'E' ? 'Masse salariale' : 'Banque',
      description: type === 'E' ? 'Ecriture salariale' : 'Transaction bancaire',
      montant: t.montant,
      type_transaction: type,
      numero_gl: t.gl,
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

module.exports = { syncTrans, montantNet };
