// Pousse les transactions d'un projet dans l'entité TransactionAvantage de Manoeuvre.
// Rattache chaque transaction à sa division (ControleBudgetaire) et à son bon de commande
// quand ils existent déjà dans Manoeuvre — sinon la transaction est créée sans lien.

const { api, apiGetAll, upsert, idOf, sleep } = require('../writers/base44-writer');

function trouverProjet(projets, code) {
  const c = String(code).replace(/^P/i, '').trim();
  return projets.find(p => {
    const cp = (p.code_projet || '').toUpperCase();
    return cp === 'P' + c || cp.includes(c) || cp === c;
  });
}

// Charge l'état Manoeuvre nécessaire au rattachement, une seule fois pour tout un cycle.
async function chargerContexte() {
  const [projets, divisions, bcs, transactions] = await Promise.all([
    apiGetAll('Projet'),
    apiGetAll('ControleBudgetaire'),
    apiGetAll('BonDeCommande'),
    apiGetAll('TransactionAvantage'),
  ]);
  return { projets, divisions, bcs, transactions };
}

// Pousse les transactions d'un projet. payloads viennent de syncAvantage.
async function pousserProjet(code, payloads, ctx) {
  const projet = trouverProjet(ctx.projets, code);
  if (!projet) return { ok: false, projet: code, error: 'Projet ' + code + ' absent de Manoeuvre' };
  const projetId = idOf(projet);

  const divMap = {};
  ctx.divisions.filter(x => x.projet_id === projetId).forEach(x => { if (x.code_division) divMap[x.code_division] = idOf(x); });

  const bcMap = {};
  ctx.bcs.filter(x => x.projet_id === projetId).forEach(x => {
    if (x.reference_avantage) bcMap[String(x.reference_avantage).padStart(9, '0')] = idOf(x);
  });

  const existingMap = {};
  ctx.transactions.filter(x => x.projet_id === projetId).forEach(x => {
    if (x.numero_journal) existingMap[x.numero_journal] = idOf(x);
  });

  let created = 0, updated = 0, errors = 0;
  for (const p of payloads) {
    const payload = Object.assign({}, p, {
      projet_id: projetId,
      controle_budgetaire_id: p.code_division ? (divMap[p.code_division] || null) : null,
      bon_de_commande_id: p.numero_commande_avantage ? (bcMap[p.numero_commande_avantage] || null) : null,
      sync_avantage_ts: new Date().toISOString(),
    });
    const existingId = existingMap[payload.numero_journal];
    const r = await upsert('TransactionAvantage', existingId || null, payload);
    if (r.ok) { existingId ? updated++ : created++; } else errors++;
    await sleep(50);
  }

  return { ok: true, projet: code, projet_id: projetId, total: payloads.length, created, updated, errors };
}

module.exports = { chargerContexte, pousserProjet, trouverProjet };
