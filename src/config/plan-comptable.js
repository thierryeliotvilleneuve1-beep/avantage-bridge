// Plan comptable de l'état des résultats.
//
// Avantage ne fournit pas de fichier de plan comptable dans les exports. Le classement
// se fait donc en trois passes, de la plus fiable à la plus approximative :
//   1. COMPTES        — numéro de GL exact, valeurs relevées dans les données réelles
//   2. PREFIXES_GL    — repli sur les deux premiers chiffres du GL
//   3. MOTS_CLES_FOURNISSEUR — pour les frais généraux dont le GL n'est pas mappé
//
// Tout ce qui reste non classé tombe dans le poste « À classer » et apparaît tel quel
// dans le rapport : rien n'est jamais perdu en silence. Ajuster ce fichier au fur et à
// mesure que les numéros de GL réels sont confirmés dans Avantage.

// GL de taxes — jamais une charge, on les retire du montant net des factures.
const GL_TAXES = ['21300', '21310', '21340', '21370'];

// Sections de l'état des résultats, dans l'ordre d'affichage.
// `exclu` marque une section qui ne participe PAS au résultat net : elle est affichée
// pour que rien ne soit caché, mais un mouvement de bilan n'est pas une charge.
const SECTIONS = {
  COUT_DIRECT: { id: 'cout_direct', libelle: 'Coût des travaux', ordre: 2 },
  FRAIS_GENERAL: { id: 'frais_general', libelle: 'Frais généraux et administration', ordre: 3 },
  NON_CLASSE: { id: 'non_classe', libelle: 'À classer', ordre: 4 },
  BILAN: { id: 'bilan', libelle: 'Mouvements de bilan — hors résultat', ordre: 5, exclu: true },
};

// Postes de l'état des résultats.
// levier = marge de manoeuvre réaliste pour réduire le poste, affichée dans le simulateur.
const POSTES = {
  sous_traitance:   { libelle: 'Sous-traitance',                 section: 'cout_direct',   levier: 'negociable' },
  materiaux:        { libelle: 'Matériaux et achats',            section: 'cout_direct',   levier: 'negociable' },
  location_equip:   { libelle: 'Location d\'équipement',         section: 'cout_direct',   levier: 'negociable' },
  mo_directe:       { libelle: 'Main-d\'oeuvre directe',         section: 'cout_direct',   levier: 'volume' },
  charges_sociales: { libelle: 'Charges sociales et avantages',  section: 'cout_direct',   levier: 'fixe' },
  autres_directs:   { libelle: 'Autres coûts de projet',         section: 'cout_direct',   levier: 'negociable' },

  salaires_struct:  { libelle: 'Salaires de structure',          section: 'frais_general', levier: 'structurel' },
  charges_struct:   { libelle: 'Charges sociales de structure',  section: 'frais_general', levier: 'fixe' },
  direction:        { libelle: 'Rémunération de la direction',   section: 'frais_general', levier: 'structurel' },
  assurances:       { libelle: 'Assurances et cautionnement',    section: 'frais_general', levier: 'negociable' },
  honoraires:       { libelle: 'Honoraires professionnels',      section: 'frais_general', levier: 'negociable' },
  loyer:            { libelle: 'Loyer, occupation et énergie',   section: 'frais_general', levier: 'structurel' },
  entretien:        { libelle: 'Entretien des bâtiments et de l\'atelier', section: 'frais_general', levier: 'negociable' },
  vehicules:        { libelle: 'Véhicules et carburant',         section: 'frais_general', levier: 'negociable' },
  outillage:        { libelle: 'Outillage et petit équipement',  section: 'frais_general', levier: 'negociable' },
  telecom_info:     { libelle: 'Télécommunications et informatique', section: 'frais_general', levier: 'negociable' },
  sst:              { libelle: 'Santé-sécurité et prévention',   section: 'frais_general', levier: 'fixe' },
  permis_cotis:     { libelle: 'Permis, licences et cotisations', section: 'frais_general', levier: 'fixe' },
  pub_dons:         { libelle: 'Publicité, dons et commandites', section: 'frais_general', levier: 'negociable' },
  bureau:           { libelle: 'Fournitures de bureau',          section: 'frais_general', levier: 'negociable' },
  deplacements:     { libelle: 'Déplacements et représentation', section: 'frais_general', levier: 'negociable' },
  finance:          { libelle: 'Frais financiers et intérêts',   section: 'frais_general', levier: 'structurel' },
  personnel_temp:   { libelle: 'Personnel temporaire et recrutement', section: 'frais_general', levier: 'negociable' },
  autres_generaux:  { libelle: 'Autres frais généraux',          section: 'frais_general', levier: 'negociable' },

  a_classer:        { libelle: 'À classer — GL non mappé',       section: 'non_classe',    levier: 'inconnu' },

  // Comptes d'actif et de passif : un virement, un remboursement de prêt ou une
  // écriture de retenue n'est pas une charge. On l'isole hors du résultat.
  mouvement_bilan:  { libelle: 'Actif et passif (virements, prêts, retenues)', section: 'bilan', levier: 'hors_resultat' },
  assurances_payees_davance: { libelle: 'Assurances payées d\'avance (compte d\'actif)', section: 'bilan', levier: 'negociable' },
};

// Passe 1 — numéros de GL exacts relevés dans les données Avantage réelles.
const COMPTES = {
  '33200': { poste: 'materiaux',        libelle: 'Achats et matériaux de projet' },
  '33500': { poste: 'sous_traitance',   libelle: 'Contrats de sous-traitance' },
  '33510': { poste: 'sous_traitance',   libelle: 'Main-d\'oeuvre sous-traitée' },
  '34100': { poste: 'mo_directe',       libelle: 'Salaires de chantier' },
  '34200': { poste: 'charges_sociales', libelle: 'Charges sociales — chantier' },
  '34300': { poste: 'charges_sociales', libelle: 'Avantages sociaux — chantier' },
  '34400': { poste: 'charges_sociales', libelle: 'Vacances et congés CCQ' },
  '34405': { poste: 'charges_sociales', libelle: 'Cotisations CCQ' },

  // --- Frais généraux. Numéros relevés et vérifiés dans l'export de production CRC,
  // avec les fournisseurs qui les alimentent réellement.
  '43100': { poste: 'salaires_struct', libelle: 'Salaires de structure' },
  '43200': { poste: 'charges_struct',  libelle: 'Charges sociales de structure' },
  '45220': { poste: 'direction',       libelle: 'Rémunération de la direction' },
  '42101': { poste: 'honoraires',      libelle: 'Honoraires juridiques et comptables' },
  '42112': { poste: 'loyer',           libelle: 'Loyer' },
  '42110': { poste: 'loyer',           libelle: 'Électricité et chauffage' },
  '42115': { poste: 'loyer',           libelle: 'Taxes et frais d\'occupation' },
  '42117': { poste: 'entretien',       libelle: 'Entretien et réparations du bâtiment' },
  '42120': { poste: 'telecom_info',    libelle: 'Informatique, télécoms et logiciels' },
  '42125': { poste: 'vehicules',       libelle: 'Véhicules — entretien et carburant' },
  '42130': { poste: 'outillage',       libelle: 'Outillage et équipement' },
  '42135': { poste: 'outillage',       libelle: 'Petit outillage et consommables' },
  '42131': { poste: 'sst',             libelle: 'Équipement de protection et SST' },
  '42107': { poste: 'pub_dons',        libelle: 'Publicité, dons et commandites' },
  '42108': { poste: 'permis_cotis',    libelle: 'Cotisations et abonnements professionnels' },
  '42104': { poste: 'deplacements',    libelle: 'Frais de déplacement du personnel' },
  '42105': { poste: 'deplacements',    libelle: 'Repas et représentation' },
  '42140': { poste: 'bureau',          libelle: 'Fournitures de bureau' },
  '42150': { poste: 'autres_generaux', libelle: 'Frais généraux divers' },
  '45230': { poste: 'autres_generaux', libelle: 'Autres charges' },

  '42106': { poste: 'autres_directs',   libelle: 'Frais de projet divers' },
  '42122': { poste: 'deplacements',     libelle: 'Déplacements' },
  '42124': { poste: 'deplacements',     libelle: 'Repas et représentation' },

  // --- Comptes de bilan identifiés nommément, pour qu'ils portent un libellé clair.
  '11145': { poste: 'assurances_payees_davance', libelle: 'Assurances et immatriculations payées d\'avance' },
};

// Passe 2 — repli par préfixe de GL. Du plus précis au plus général : le premier
// préfixe qui correspond gagne, donc l'ordre compte.
const PREFIXES_GL = [
  { prefixe: '332', poste: 'materiaux' },
  { prefixe: '333', poste: 'location_equip' },
  { prefixe: '335', poste: 'sous_traitance' },
  { prefixe: '341', poste: 'mo_directe' },
  { prefixe: '342', poste: 'charges_sociales' },
  { prefixe: '343', poste: 'charges_sociales' },
  { prefixe: '344', poste: 'charges_sociales' },
  { prefixe: '33',  poste: 'autres_directs' },
  { prefixe: '34',  poste: 'charges_sociales' },
  { prefixe: '35',  poste: 'location_equip' },
  { prefixe: '51',  poste: 'salaires_struct' },
  { prefixe: '52',  poste: 'assurances' },
  // La série 42xxx / 43xxx / 45xxx d'Avantage regroupe les frais d'administration.
  { prefixe: '42',  poste: 'autres_generaux' },
  { prefixe: '43',  poste: 'autres_generaux' },
  { prefixe: '45',  poste: 'autres_generaux' },
  // Actif (1xxxx) et passif (2xxxx) : hors résultat.
  { prefixe: '1',   poste: 'mouvement_bilan' },
  { prefixe: '2',   poste: 'mouvement_bilan' },
];

// Passe 3 — mots-clés de fournisseur, pour les frais généraux sans GL mappé.
// Les fournisseurs listés ici proviennent des données réelles de CRC.
const MOTS_CLES_FOURNISSEUR = [
  // Règles les plus spécifiques d'abord : la première qui mord gagne.
  { poste: 'sst',            mots: ['conseils pg sst', 'spi securite', 'spi securité', 'prevention sst'] },
  { poste: 'outillage',      mots: ['canac', 'outil mag', 'outillage', 'quincaillerie', 'coop novago',
                                    'location st-tite', 'slm equipements', 'manulift', 'batterie mauricie'] },
  { poste: 'assurances',     mots: ['assurance', 'aviva', 'bfl canada', 'northbridge', 'intact', 'cautionnement', 'trisura'] },
  { poste: 'honoraires',     mots: ['avocat', 'notaire', 'mallette', 'raymond chabot', 'deloitte', 'senc', 's.e.n.c', 'belanger sauve',
                                    'ds avocats', 'desaulniers', 'comptable', 'cpa', 'ingenieur', 'ing.', 'architecte', 'arpenteur',
                                    'b.sc', 'm. env', 'consultant'] },
  { poste: 'permis_cotis',   mots: ['regie du batiment', 'rbq', 'ccq', 'acq', 'commission de la construction', 'revenu quebec',
                                    'registraire', 'cnesst', 'licence', 'permis'] },
  { poste: 'telecom_info',   mots: ['bell', 'telus', 'videotron', 'cogeco', 'rogers', 'microsoft', 'google', 'adobe', 'autodesk',
                                    'procore', 'acceo', 'logiciel', 'informatique', 'internet'] },
  { poste: 'vehicules',      mots: ['petrole', 'petro', 'esso', 'shell', 'ultramar', 'couche-tard', 'garage', 'pneu', 'ford',
                                    'gm ', 'chevrolet', 'toyota', 'location auto', 'saaq', 'carburant', 'diesel'] },
  { poste: 'loyer',          mots: ['loyer', 'immeuble', 'immobili', 'hydro-quebec', 'hydro quebec', 'gaz metro', 'energir',
                                    'entretien menager', 'concierge'] },
  { poste: 'personnel_temp', mots: ['randstad', 'adecco', 'manpower', 'agence de placement', 'recrutement', 'interim'] },
  { poste: 'bureau',         mots: ['bureau en gros', 'bureaugros', 'staples', 'papeterie', 'fourniture de bureau', 'poste canada', 'purolator'] },
  { poste: 'finance',        mots: ['desjardins', 'banque', 'visa', 'mastercard', 'interet', 'frais bancaire', 'financement'] },
  { poste: 'salaires_struct', mots: ['masse salariale', 'salaire'] },
];

// Normalise pour la comparaison : minuscules, sans accents.
function normaliser(txt) {
  return (txt || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Postes fourre-tout : un préfixe de GL qui n'aboutit qu'à l'un de ceux-là n'apporte
// presque rien. Dans ce cas, le nom du fournisseur est un signal bien plus précis et
// c'est lui qui doit gagner — sinon toute la ventilation des frais généraux
// s'effondrerait dans « Autres ».
const POSTES_FOURRE_TOUT = ['autres_generaux', 'autres_directs'];

// Classe une ligne de charge. `estProjet` distingue un coût de projet d'un frais général :
// une facture sans numéro de projet dans Avantage est par définition un frais général.
function classer(numeroGl, fournisseur, estProjet) {
  const gl = (numeroGl || '').toString().trim();
  const etiquette = gl ? 'GL ' + gl : 'Sans numéro de GL';
  const glAffiche = gl || '(sans GL)';

  // Passe 1 — GL exact
  if (COMPTES[gl]) {
    const c = COMPTES[gl];
    // Un GL de coût de projet apparaissant sur une facture sans projet est un frais général.
    if (!estProjet && estCoutDirect(c.poste)) {
      return { poste: reclasserEnGeneral(fournisseur), gl, libelleCompte: c.libelle, passe: 'gl_exact_reclasse' };
    }
    return { poste: c.poste, gl, libelleCompte: c.libelle, passe: 'gl_exact' };
  }

  // Passe 2 — préfixe de GL
  if (gl) {
    for (const p of PREFIXES_GL) {
      if (!gl.startsWith(p.prefixe)) continue;

      // Préfixe imprécis : on tente d'abord le fournisseur.
      if (POSTES_FOURRE_TOUT.includes(p.poste)) {
        const parMot = chercherParFournisseur(fournisseur);
        if (parMot && !(estProjet && !estCoutDirect(parMot))) {
          return { poste: parMot, gl, libelleCompte: etiquette, passe: 'fournisseur' };
        }
      }

      if (!estProjet && estCoutDirect(p.poste)) {
        return { poste: reclasserEnGeneral(fournisseur), gl, libelleCompte: etiquette, passe: 'prefixe_reclasse' };
      }
      return { poste: p.poste, gl, libelleCompte: etiquette, passe: 'prefixe' };
    }
  }

  // Passe 3 — mots-clés de fournisseur
  const parMot = chercherParFournisseur(fournisseur);
  if (parMot) {
    return { poste: parMot, gl: glAffiche, libelleCompte: etiquette, passe: 'fournisseur' };
  }

  // Rien n'a mordu : on l'expose au lieu de le noyer.
  return {
    poste: estProjet ? 'autres_directs' : 'a_classer',
    gl: glAffiche,
    libelleCompte: etiquette,
    passe: 'non_classe',
  };
}

function estCoutDirect(idPoste) {
  return Boolean(POSTES[idPoste] && POSTES[idPoste].section === 'cout_direct');
}

function chercherParFournisseur(fournisseur) {
  const f = normaliser(fournisseur);
  if (!f) return null;
  for (const regle of MOTS_CLES_FOURNISSEUR) {
    if (regle.mots.some(m => f.includes(normaliser(m)))) return regle.poste;
  }
  return null;
}

function reclasserEnGeneral(fournisseur) {
  return chercherParFournisseur(fournisseur) || 'autres_generaux';
}

module.exports = {
  GL_TAXES, SECTIONS, POSTES, COMPTES, PREFIXES_GL, MOTS_CLES_FOURNISSEUR,
  classer, normaliser,
};
