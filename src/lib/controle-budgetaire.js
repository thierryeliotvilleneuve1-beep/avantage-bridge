/**
 * Assemble les exports Avantage en lignes de controle budgetaire calculees,
 * avec prevision a terminaison et marge. Aucune ecriture : cette couche
 * produit la donnee, les routes decident quoi en faire.
 */

const sources = require('./sources');
const { computeDivision, agregerProjet, r2 } = require('./marge');

/**
 * @param {string} code            numero de projet sans prefixe P
 * @param {object} [opts]
 * @param {number} [opts.odcParDivision]  map code_division -> montant ODC
 * @param {'budget'|'engagement'} [opts.methode]
 */
function construireProjet(code, opts = {}) {
  const { odcParDivision = {}, methode = 'budget' } = opts;

  const active = sources.loadActive();
  const conpre = sources.loadConpre(code);
  const confit = sources.loadConfit(code);
  const conact = sources.loadConact(code);
  const trans = sources.loadTrans(code);
  const comite = sources.loadComiteDivisionMap();
  const pybbil = sources.loadPybbilParCommande(code);
  const comman = sources.loadComman(code);

  // Bons de commande regroupes par division, avec leur montant deja facture.
  const bcsParDivision = {};
  let bcSansDivision = 0;
  for (const bc of comman.bcs) {
    const division = comite.map[bc.numero];
    const facture = pybbil.parCommande[bc.numero] || 0;
    if (!division) {
      bcSansDivision += Math.max(bc.montant_prevu, facture);
      continue;
    }
    if (!bcsParDivision[division]) bcsParDivision[division] = [];
    bcsParDivision[division].push({
      numero: bc.numero,
      fournisseur: bc.fournisseur,
      montant_prevu: bc.montant_prevu,
      montant_facture: facture,
    });
  }

  // Univers des divisions : budget, revenus, couts reels et BC peuvent chacun
  // reveler une division que les autres ignorent.
  const codes = new Set([
    ...Object.keys(conpre.map),
    ...Object.keys(confit.map),
    ...Object.keys(trans.couts),
    ...Object.keys(trans.mo),
    ...Object.keys(bcsParDivision),
    ...Object.keys(conact.map),
  ].filter(Boolean));

  const divisions = [...codes].sort().map((codeDivision) => {
    const bcs = bcsParDivision[codeDivision] || [];
    const coutReel = trans.couts[codeDivision] || 0;
    const moTotal = trans.mo[codeDivision] || 0;
    // Depenses reelles non rattachees a un BC de cette division : elles comptent
    // dans l'engagement au meme titre qu'un BC signe.
    const factureSurBcs = bcs.reduce((a, bc) => a + bc.montant_facture, 0);
    const transactionsSansBC = Math.max(0, coutReel - factureSurBcs);

    return computeDivision({
      code_division: codeDivision,
      nom_division: active.map[codeDivision] || codeDivision,
      montant_initial: conpre.map[codeDivision] || 0,
      odc: odcParDivision[codeDivision] || 0,
      budget_revenus: confit.map[codeDivision] || 0,
      cout_reel_hors_mo: coutReel,
      mo_total: moTotal,
      bcs,
      transactions_sans_bc: transactionsSansBC,
      depense_a_venir: (conact.map[codeDivision] || {}).depense_a_venir || 0,
      facture: (conact.map[codeDivision] || {}).facture || 0,
      methode,
    });
  });

  const rollup = agregerProjet(divisions);

  const avertissements = [];
  if (!confit.disponible) {
    avertissements.push(
      confit.fichier_present
        ? 'CONFIT.csv present mais colonnes revenus introuvables — marge non calculable.'
        : 'CONFIT.csv absent — budget de revenus inconnu, donc AUCUNE marge calculable. C\'est la source a exporter en priorite.'
    );
  }
  if (!comman.disponible) avertissements.push('export.xlsx#COMMAN absent — engagement sur BC non calculable, la prevision est sous-estimee.');
  if (!pybbil.disponible) avertissements.push('PYBBIL.csv absent — montants factures par BC inconnus.');
  if (!conpre.disponible) avertissements.push('CONPRE.csv absent — budget de couts inconnu.');
  if (!trans.disponible) avertissements.push('TRANS.csv absent — couts reels inconnus.');
  if (bcSansDivision > 0) {
    avertissements.push(`${r2(bcSansDivision)} $ de BC sans division rattachee dans COMITE — exclus du calcul par division.`);
  }
  if (rollup.marge_partielle) {
    avertissements.push(`${rollup.divisions_sans_revenu} division(s) sans budget de revenus — la marge affichee est partielle.`);
  }

  return {
    code_projet: code,
    divisions,
    rollup: { ...rollup, bc_sans_division: r2(bcSansDivision) },
    avertissements,
    sources: {
      CONPRE: { disponible: conpre.disponible, maj: conpre.maj || null },
      CONFIT: { disponible: confit.disponible, fichier_present: confit.fichier_present, maj: confit.maj || null },
      CONACT: { disponible: conact.disponible, maj: conact.maj || null },
      TRANS: { disponible: trans.disponible, maj: trans.maj || null },
      COMITE: { disponible: comite.disponible, maj: comite.maj || null },
      PYBBIL: { disponible: pybbil.disponible, maj: pybbil.maj || null },
      COMMAN: { disponible: comman.disponible, maj: comman.maj || null },
      ACTIVE: { disponible: active.disponible, maj: active.maj || null },
    },
  };
}

module.exports = { construireProjet };
