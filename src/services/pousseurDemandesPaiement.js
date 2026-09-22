// Recopie les demandes de paiement d'Avantage (CONFIT) dans Manoeuvre.
//
// CONFIT porte l'état COURANT de la facturation par contrat + division (la « dernière DP »).
// Pour chaque projet ACTIF présent dans Manoeuvre, on maintient UNE demande de paiement
// « courante » (numero_dp = 0, statut Brouillon) et ses lignes par division — recopie fidèle
// des montants d'Avantage, aucun calcul métier côté Base44.
//
// L'historique numéroté déjà présent (DP 1, 2, 3… importées auparavant) n'est PAS touché :
// on ne cible que l'enregistrement sentinelle numero_dp = 0.
//
// Non lisibles depuis Avantage (FACTMA chiffrée) : n° de facture et dates → laissés vides.

const { apiGetAll, upsert, idOf, inchange, sleep } = require('../writers/base44-writer');
const dpDbf = require('../sources/demandesPaiementDbf');

const NUMERO_COURANT = 0; // sentinelle : l'état courant mirroré, distinct des DP numérotées
const NOTE_COURANTE = 'État courant Avantage (CONFIT) — synchronisé automatiquement, ne pas éditer.';
const CHAMPS_ENTETE = ['numero_dp', 'montant_total', 'statut'];
const CHAMPS_LIGNE = ['prix_contractuel', 'montant_anterieur', 'montant_cumulatif', 'montant_dp', 'pourcentage_cumulatif', 'nom_division', 'controle_budgetaire_id'];

function codeNumerique(p) { return parseInt(String(p.code_projet || '').replace(/^P/i, '').trim(), 10); }
function estActif(p) { return !/(termine|annule|archiv|ferm|clos|inactif)/i.test(p.statut || ''); }

async function pousserToutesDemandes(ctx) {
  const res = { ok: true, projets: 0, entetes_maj: 0, lignes_created: 0, lignes_updated: 0, lignes_unchanged: 0, errors: 0 };
  if (!dpDbf.disponible()) { res.ok = true; res.note = 'CONFIT introuvable — étape ignorée'; return res; }

  const parContrat = dpDbf.lireParProjet();
  if (!parContrat.size) { res.note = 'CONFIT vide'; return res; }

  const projetsActifs = (ctx.projets || []).filter(estActif);
  const divisions = ctx.divisions || await apiGetAll('ControleBudgetaire');
  const entetes = await apiGetAll('DemandesPaiement');
  const lignes = await apiGetAll('LignesDP');

  for (const projet of projetsActifs) {
    const code = codeNumerique(projet);
    const data = parContrat.get(code);
    if (!data || !data.divisions.length) continue; // pas de facturation Avantage pour ce projet
    const projetId = idOf(projet);

    try {
      // 1. En-tête « courant » (numero_dp = 0), créé ou mis à jour.
      const exEntete = entetes.find(d => d.projet_id === projetId && Number(d.numero_dp) === NUMERO_COURANT);
      const payloadEntete = {
        projet_id: projetId,
        numero_dp: NUMERO_COURANT,
        montant_total: data.montant_total,
        statut: 'Brouillon',
        notes: NOTE_COURANTE,
      };
      let dpId = exEntete ? idOf(exEntete) : null;
      if (!exEntete || !inchange(exEntete, payloadEntete, CHAMPS_ENTETE)) {
        payloadEntete.sync_avantage_ts = new Date().toISOString();
        const r = await upsert('DemandesPaiement', dpId, payloadEntete);
        if (r.ok) { res.entetes_maj++; if (!dpId && r.body) dpId = idOf(r.body); }
        else { res.errors++; continue; }
        await sleep(60);
      }
      if (!dpId) { res.errors++; continue; }

      // 2. Lignes par division, différentiel sur la DP courante uniquement.
      const div2cb = {};
      divisions.filter(x => x.projet_id === projetId).forEach(x => { if (x.code_division) div2cb[x.code_division] = x; });
      const lignesExistantes = {};
      lignes.filter(l => l.demande_paiement_id === dpId).forEach(l => { if (l.code_division) lignesExistantes[l.code_division] = l; });

      for (const d of data.divisions) {
        const cb = div2cb[d.code_division];
        const payload = {
          demande_paiement_id: dpId,
          projet_id: projetId,
          controle_budgetaire_id: cb ? idOf(cb) : (lignesExistantes[d.code_division] && lignesExistantes[d.code_division].controle_budgetaire_id) || '',
          code_division: d.code_division,
          nom_division: (cb && cb.nom_division) || (lignesExistantes[d.code_division] && lignesExistantes[d.code_division].nom_division) || d.code_division,
          prix_contractuel: d.prix_contractuel,
          montant_anterieur: d.montant_anterieur,
          montant_cumulatif: d.montant_cumulatif,
          montant_dp: d.montant_dp,
          pourcentage_cumulatif: d.pourcentage_cumulatif,
        };
        const ex = lignesExistantes[d.code_division];
        if (ex && inchange(ex, payload, CHAMPS_LIGNE)) { res.lignes_unchanged++; continue; }
        payload.sync_avantage_ts = new Date().toISOString();
        const r = await upsert('LignesDP', ex ? idOf(ex) : null, payload);
        if (r.ok) { ex ? res.lignes_updated++ : res.lignes_created++; } else res.errors++;
        await sleep(50);
      }
      res.projets++;
    } catch (e) { res.errors++; console.error('[DP]', projet.code_projet, e.message); }
  }
  return res;
}

module.exports = { pousserToutesDemandes };
