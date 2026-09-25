// Pousse les DEMANDES DE PAIEMENT NUMÉROTÉES d'Avantage (CONFAC + CONFIT) dans Manœuvre.
//
// Une DP par en-tête CONFAC (numero_dp, date, n° de facture), avec ses lignes par division
// (état de CE cycle). Remplace l'ancien miroir unique « DP-0 » (que ce pousseur SUPPRIME).
//
// DRY-RUN PAR DÉFAUT : sans opts.dryRun===false, rien n'est écrit — on renvoie le plan
// (DP à créer/mettre à jour, lignes, et le DP-0 à supprimer). L'écriture n'a lieu qu'avec apply.

const { apiGetAll, upsert, idOf, inchange, sleep, api } = require('../writers/base44-writer');
const dpDbf = require('../sources/demandesPaiementDbf');

const CHAMPS_DP = ['numero_dp', 'numero_facture_avantage', 'date_dp', 'montant_total', 'statut'];
const CHAMPS_LIGNE = ['controle_budgetaire_id', 'nom_division', 'prix_contractuel', 'montant_anterieur',
  'montant_cumulatif', 'pourcentage_cumulatif', 'montant_dp', 'pourcentage_dp'];

function codeNum(p) { return parseInt(String(p.code_projet || '').replace(/^P/i, '').trim(), 10); }
function estActif(p) { return !/(termine|annule|archiv|ferm|clos|inactif)/i.test(p.statut || ''); }
function dateISO(v) { const s = String(v || '').trim(); return s ? s.replace(/\//g, '-') : ''; }
function statutDe(dp) { return dp.numero_facture ? 'Approuvé' : 'Brouillon'; }

async function pousserDPNumerotees(ctx, opts) {
  const dryRun = !(opts && opts.dryRun === false);
  if (!dpDbf.disponible()) return { ok: true, note: 'CONFIT/CONFAC introuvables — étape ignorée' };

  const projets = ((ctx && ctx.projets) || await apiGetAll('Projet')).filter(estActif);
  const entetes = (ctx && ctx.dp_entetes) || await apiGetAll('DemandesPaiement');
  const lignes = (ctx && ctx.dp_lignes) || await apiGetAll('LignesDP');
  const divisions = (ctx && ctx.divisions) || await apiGetAll('ControleBudgetaire');

  const res = { ok: true, dry_run: dryRun, projets: 0, dp_created: 0, dp_updated: 0, dp_unchanged: 0,
    lignes_created: 0, lignes_updated: 0, lignes_unchanged: 0, dp0_supprimes: 0, lignes_supprimees: 0, errors: 0, apercu: [] };

  for (const projet of projets) {
    const code = codeNum(projet); if (!code) continue;
    let rec; try { rec = dpDbf.lireDPNumerotees(code); } catch (e) { res.errors++; continue; }
    if (!rec.ok || !rec.dps.length) continue;
    const projetId = idOf(projet);

    const dpProjet = entetes.filter(d => d.projet_id === projetId);
    const div2cb = {};
    divisions.filter(x => x.projet_id === projetId).forEach(x => { if (x.code_division) div2cb[x.code_division] = x; });

    for (const dp of rec.dps) {
      const exDP = dpProjet.find(d => Number(d.numero_dp) === dp.numero_dp);
      const payloadDP = {
        projet_id: projetId,
        numero_dp: dp.numero_dp,
        numero_facture_avantage: dp.numero_facture || '',
        date_dp: dateISO(dp.date_demande),
        montant_total: dp.montant_total,
        statut: statutDe(dp),
        notes: 'Synchronisé depuis Avantage (CONFAC/CONFIT) — ne pas éditer.',
      };
      let dpId = exDP ? idOf(exDP) : null;
      if (!exDP || !inchange(exDP, payloadDP, CHAMPS_DP)) {
        if (!dryRun) {
          payloadDP.sync_avantage_ts = new Date().toISOString();
          const w = await upsert('DemandesPaiement', dpId, payloadDP);
          if (w.ok) { exDP ? res.dp_updated++ : res.dp_created++; if (!dpId && w.body) dpId = idOf(w.body); }
          else { res.errors++; continue; }
          await sleep(60);
        } else { exDP ? res.dp_updated++ : res.dp_created++; }
      } else { res.dp_unchanged++; }

      // Lignes de CETTE DP.
      const lignesEx = {};
      if (dpId) lignes.filter(l => l.demande_paiement_id === dpId).forEach(l => { if (l.code_division) lignesEx[l.code_division] = l; });
      for (const d of dp.divisions) {
        const cb = div2cb[d.code_division];
        const payloadL = {
          demande_paiement_id: dpId || '(nouveau)',
          projet_id: projetId,
          controle_budgetaire_id: cb ? idOf(cb) : (lignesEx[d.code_division] && lignesEx[d.code_division].controle_budgetaire_id) || '',
          code_division: d.code_division,
          nom_division: (cb && cb.nom_division) || (lignesEx[d.code_division] && lignesEx[d.code_division].nom_division) || d.code_division,
          prix_contractuel: d.prix_contractuel,
          montant_anterieur: d.montant_anterieur,
          montant_cumulatif: d.montant_cumulatif,
          pourcentage_cumulatif: d.pourcentage_cumulatif,
          montant_dp: d.montant_dp,
          pourcentage_dp: d.pourcentage_dp,
        };
        const exL = lignesEx[d.code_division];
        if (exL && inchange(exL, payloadL, CHAMPS_LIGNE)) { res.lignes_unchanged++; continue; }
        if (!dryRun && dpId) {
          payloadL.sync_avantage_ts = new Date().toISOString();
          const w = await upsert('LignesDP', exL ? idOf(exL) : null, payloadL);
          if (w.ok) { exL ? res.lignes_updated++ : res.lignes_created++; } else res.errors++;
          await sleep(40);
        } else { exL ? res.lignes_updated++ : res.lignes_created++; }
      }
    }

    // Nettoyage : l'ancien miroir DP-0 (créé par le pont) est remplacé par les DP numérotées.
    const sentinelles = dpProjet.filter(d => Number(d.numero_dp) === 0);
    for (const s of sentinelles) {
      const sid = idOf(s);
      const sesLignes = lignes.filter(l => l.demande_paiement_id === sid);
      if (!dryRun) {
        for (const l of sesLignes) { const w = await api('DELETE', '/entities/LignesDP/' + idOf(l)); if (w.status === 200) res.lignes_supprimees++; await sleep(40); }
        const w = await api('DELETE', '/entities/DemandesPaiement/' + sid); if (w.status === 200) res.dp0_supprimes++;
        await sleep(60);
      } else { res.lignes_supprimees += sesLignes.length; res.dp0_supprimes++; }
    }

    res.projets++;
    res.apercu.push({ code_projet: projet.code_projet, nb_dp: rec.dps.length,
      dps: rec.dps.map(d => ({ numero_dp: d.numero_dp, facture: d.numero_facture || null, statut: statutDe(d), montant_total: d.montant_total, cumulatif: d.montant_cumulatif })) });
  }
  return res;
}

module.exports = { pousserDPNumerotees };
