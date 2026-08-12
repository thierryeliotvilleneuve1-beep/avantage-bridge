// Construction de l'état des résultats avec drill-down.
//
// LECTURE SEULE — ce service n'écrit nulle part. Il agrège ce qu'Avantage contient.
//
// Hiérarchie produite, cinq niveaux :
//   section  (Coût des travaux / Frais généraux / À classer)
//     └─ poste     (Sous-traitance, Assurances, Honoraires…)
//         └─ compte GL
//             └─ fournisseur
//                 └─ facture
//
// Le montant d'un niveau est toujours la somme exacte du niveau inférieur : on peut
// descendre de la ligne « Frais généraux » jusqu'à une facture précise sans écart.

const source = require('../sources/donneesAvantage');
const { classer, POSTES, SECTIONS } = require('../config/plan-comptable');

function arrondi(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Ordre d'affichage des postes tel que défini dans le plan comptable.
const ORDRE_POSTES = Object.keys(POSTES);

function construireArbre(charges, activites, commandeDivisions) {
  // Index : section > poste > gl > fournisseur > factures
  const racine = {};
  const nonClasses = { lignes: 0, montant: 0, gl: {} };

  for (const l of charges) {
    const cl = classer(l.numeroGl, l.fournisseur, l.estProjet);
    const poste = POSTES[cl.poste] || POSTES.a_classer;
    const idSection = poste.section;

    if (cl.passe === 'non_classe') {
      nonClasses.lignes++;
      nonClasses.montant = arrondi(nonClasses.montant + l.montant);
      const k = cl.gl;
      nonClasses.gl[k] = arrondi((nonClasses.gl[k] || 0) + l.montant);
    }

    const sec = racine[idSection] || (racine[idSection] = { id: idSection, total: 0, postes: {} });
    const pst = sec.postes[cl.poste] || (sec.postes[cl.poste] = {
      id: cl.poste, libelle: poste.libelle, levier: poste.levier, total: 0, comptes: {},
    });
    const cpt = pst.comptes[cl.gl] || (pst.comptes[cl.gl] = {
      gl: cl.gl, libelle: cl.libelleCompte, total: 0, fournisseurs: {},
    });
    const nomF = l.fournisseur || '(fournisseur non identifié)';
    const frn = cpt.fournisseurs[nomF] || (cpt.fournisseurs[nomF] = {
      nom: nomF, total: 0, nb: 0, factures: [],
    });

    // Division CSI : soit portée par l'écriture, soit déduite du numéro de commande.
    let division = l.codeActivite || '';
    if (!division && l.numeroCommande) {
      division = commandeDivisions[l.numeroCommande.padStart(9, '0')] || '';
    }

    frn.factures.push({
      date: l.date,
      numeroFacture: l.numeroFacture || l.numeroJournal || '',
      projet: l.numeroProjet || '',
      division,
      divisionNom: division ? (activites[division] || '') : '',
      description: l.description || '',
      montant: arrondi(l.montant),
      source: l.source,
    });

    frn.nb++;
    frn.total = arrondi(frn.total + l.montant);
    cpt.total = arrondi(cpt.total + l.montant);
    pst.total = arrondi(pst.total + l.montant);
    sec.total = arrondi(sec.total + l.montant);
  }

  // Transformation en tableaux triés par montant décroissant, du plus gros levier au plus petit.
  const sections = Object.values(SECTIONS)
    .filter(s => racine[s.id])
    .sort((a, b) => a.ordre - b.ordre)
    .map(sDef => {
      const s = racine[sDef.id];
      const postes = Object.values(s.postes)
        .sort((a, b) => (ORDRE_POSTES.indexOf(a.id) - ORDRE_POSTES.indexOf(b.id)))
        .map(p => ({
          id: p.id, libelle: p.libelle, levier: p.levier, total: p.total,
          comptes: Object.values(p.comptes).sort((a, b) => b.total - a.total).map(c => ({
            gl: c.gl, libelle: c.libelle, total: c.total,
            fournisseurs: Object.values(c.fournisseurs).sort((a, b) => b.total - a.total).map(f => ({
              nom: f.nom, total: f.total, nb: f.nb,
              factures: f.factures.sort((x, y) => (y.date || '').localeCompare(x.date || '')),
            })),
          })),
        }));
      return { id: sDef.id, libelle: sDef.libelle, exclu: Boolean(sDef.exclu), total: s.total, postes };
    });

  return { sections, nonClasses };
}

function regrouperRevenus(revenus, projets) {
  const parProjet = {};
  for (const f of revenus) {
    const cle = f.numeroProjet || '(sans projet)';
    const p = parProjet[cle] || (parProjet[cle] = {
      projet: cle,
      nom: (projets[cle] && projets[cle].nom) || '',
      client: (projets[cle] && projets[cle].client) || f.client || '',
      total: 0, soldeOuvert: 0, retenue: 0, nb: 0, factures: [],
    });
    p.total = arrondi(p.total + f.montant);
    p.soldeOuvert = arrondi(p.soldeOuvert + f.soldeOuvert);
    p.retenue = arrondi(p.retenue + f.retenue);
    p.nb++;
    p.factures.push({
      date: f.date, numeroFacture: f.numeroFacture, client: f.client,
      montant: arrondi(f.montant), soldeOuvert: arrondi(f.soldeOuvert), retenue: arrondi(f.retenue),
    });
  }
  const liste = Object.values(parProjet).sort((a, b) => b.total - a.total);
  liste.forEach(p => p.factures.sort((x, y) => (y.date || '').localeCompare(x.date || '')));
  return liste;
}

// Construit l'état des résultats complet pour une période.
// Revenus et coûts mois par mois.
//
// POURQUOI C'EST INDISPENSABLE
// En construction, les coûts s'enregistrent quand ils sont engagés et les revenus quand
// ils sont facturés. À n'importe quelle date de coupure, il reste donc des travaux exécutés
// et non encore facturés. Un total sur douze mois qui se termine en pleine saison affiche
// une marge écrasée sans que rien n'aille mal : c'est du décalage, pas une perte.
//
// Le seul moyen de distinguer un décalage de facturation d'un vrai problème de rentabilité
// est de regarder la courbe. Un mois où le coût dépasse le revenu, en fin de période, se
// rattrape à la facturation suivante. Le même écart tous les mois de l'année, non.
function repartirParMois(revenus, charges, debut, fin) {
  const mois = {};
  const seau = date => {
    const m = (date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) return null;
    if (!mois[m]) {
      mois[m] = { mois: m, revenus: 0, cout_direct: 0, frais_generaux: 0, autres: 0 };
    }
    return mois[m];
  };

  for (const r of revenus) {
    const s = seau(r.date);
    if (s) s.revenus += r.montant;
  }

  for (const l of charges) {
    const s = seau(l.date);
    if (!s) continue;
    const cl = classer(l.numeroGl, l.fournisseur, l.estProjet);
    const poste = POSTES[cl.poste] || POSTES.a_classer;
    // Un mouvement de bilan n'est pas une charge : il ne doit pas peser sur la marge.
    const section = Object.values(SECTIONS).find(x => x.id === poste.section);
    if (section && section.exclu) continue;
    if (poste.section === 'cout_direct') s.cout_direct += l.montant;
    else if (poste.section === 'frais_general') s.frais_generaux += l.montant;
    else s.autres += l.montant;
  }

  return Object.keys(mois).sort().map(m => {
    const v = mois[m];
    const margeBrute = arrondi(v.revenus - v.cout_direct);
    return {
      mois: m,
      revenus: arrondi(v.revenus),
      cout_direct: arrondi(v.cout_direct),
      marge_brute: margeBrute,
      marge_brute_pct: v.revenus ? arrondi((margeBrute / v.revenus) * 100) : null,
      frais_generaux: arrondi(v.frais_generaux + v.autres),
      resultat_net: arrondi(margeBrute - v.frais_generaux - v.autres),
    };
  });
}

async function construire(debut, fin) {
  source.reinitialiser();

  // Si la base est joignable, on déduit d abord les colonnes des tables non nommées.
  // Une seule fois par démarrage ; les tables non validées restent lues en CSV.
  await source.autoMapper();

  const [revenus, charges, projets, activites, commandeDivisions] = await Promise.all([
    source.chargerRevenus(debut, fin),
    source.chargerCharges(debut, fin),
    source.chargerProjets(),
    source.chargerActivites(),
    source.chargerCommandeDivisions(),
  ]);

  const revenusParProjet = regrouperRevenus(revenus, projets);
  const totalRevenus = arrondi(revenusParProjet.reduce((s, p) => s + p.total, 0));
  const soldeOuvert = arrondi(revenusParProjet.reduce((s, p) => s + p.soldeOuvert, 0));

  const { sections, nonClasses } = construireArbre(charges, activites, commandeDivisions);

  const sec = id => sections.find(s => s.id === id);
  const totalCoutDirect = sec('cout_direct') ? sec('cout_direct').total : 0;
  const totalFraisGeneraux = sec('frais_general') ? sec('frais_general').total : 0;
  const totalNonClasse = sec('non_classe') ? sec('non_classe').total : 0;
  // Les mouvements de bilan sont affichés mais ne touchent pas le résultat.
  const totalBilan = sec('bilan') ? sec('bilan').total : 0;

  const margeBrute = arrondi(totalRevenus - totalCoutDirect);
  const resultatNet = arrondi(margeBrute - totalFraisGeneraux - totalNonClasse);

  // Nombre de mois couverts, pour annualiser proprement. On arrondit une seule fois
  // et on réutilise cette valeur partout : le lecteur peut ainsi refaire l'annualisation
  // à partir du nombre de mois affiché et retomber exactement sur nos chiffres.
  const mois = arrondi(moisEntre(debut, fin));
  const mensuel = repartirParMois(revenus, charges, debut, fin);

  return {
    genere_le: new Date().toISOString(),
    lecture_seule: true,
    periode: { debut, fin, mois },
    provenance: source.provenance(),
    revenus: {
      total: totalRevenus,
      solde_ouvert: soldeOuvert,
      nb_factures: revenus.length,
      projets: revenusParProjet,
    },
    sections,
    mensuel,
    totaux: {
      revenus: totalRevenus,
      cout_direct: totalCoutDirect,
      marge_brute: margeBrute,
      marge_brute_pct: totalRevenus ? arrondi((margeBrute / totalRevenus) * 100) : null,
      frais_generaux: totalFraisGeneraux,
      non_classe: totalNonClasse,
      mouvements_bilan: totalBilan,
      resultat_net: resultatNet,
      resultat_net_pct: totalRevenus ? arrondi((resultatNet / totalRevenus) * 100) : null,
      // Seuil de rentabilité : revenus nécessaires pour absorber les frais généraux
      // à la marge brute observée.
      seuil_rentabilite: (totalRevenus && margeBrute > 0)
        ? arrondi((totalFraisGeneraux + totalNonClasse) / (margeBrute / totalRevenus))
        : null,
    },
    annualise: mois > 0 ? {
      revenus: arrondi(totalRevenus / mois * 12),
      cout_direct: arrondi(totalCoutDirect / mois * 12),
      frais_generaux: arrondi(totalFraisGeneraux / mois * 12),
      resultat_net: arrondi(resultatNet / mois * 12),
    } : null,
    qualite: {
      lignes_de_charge: charges.length,
      lignes_non_classees: nonClasses.lignes,
      montant_non_classe: nonClasses.montant,
      // Part non classée mesurée sur les charges qui comptent dans le résultat,
      // mouvements de bilan exclus.
      pct_non_classe: (totalCoutDirect + totalFraisGeneraux + totalNonClasse) > 0
        ? arrondi(totalNonClasse / (totalCoutDirect + totalFraisGeneraux + totalNonClasse) * 100)
        : 0,
      gl_a_mapper: Object.entries(nonClasses.gl)
        .sort((a, b) => b[1] - a[1])
        .map(([g, m]) => ({ gl: g, montant: m })),
    },
  };
}

function moisEntre(debut, fin) {
  if (!debut || !fin) return 0;
  const d = new Date(debut + 'T00:00:00Z');
  const f = new Date(fin + 'T00:00:00Z');
  if (isNaN(d) || isNaN(f) || f <= d) return 0;
  return (f - d) / (1000 * 60 * 60 * 24) / 30.4375;
}

module.exports = { construire };
