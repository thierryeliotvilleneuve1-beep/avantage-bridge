// Correspondance entre les champs logiques du bridge et les colonnes réelles d'Avantage.
//
// POURQUOI CE FICHIER
// Les exports CSV d'Avantage sont positionnels : le bridge lisait jusqu'ici PYBBIL par
// index de colonne (r[33] = numéro de projet, etc.). En lecture directe dans la base, il
// faut les vrais noms de colonnes. Ils ne sont pas documentés publiquement et varient
// selon la version d'Avantage installée.
//
// COMMENT LE REMPLIR
//   1. Lancer  GET /api/etat-resultats/diagnostic-bd   (route d'introspection)
//      -> elle liste les tables et les colonnes réellement présentes.
//   2. Reporter les noms ici.
// Tant qu'une table n'est pas mappée, le bridge retombe automatiquement sur l'export CSV
// correspondant et le signale dans le diagnostic. Aucun chiffre n'est inventé.
//
// La colonne « index CSV » ci-dessous est la position connue et vérifiée dans l'export,
// elle sert de repère pour identifier la bonne colonne dans la base.

const TABLES = {
  // Factures fournisseurs. Cœur de l'état des résultats : porte les charges et leur
  // ventilation GL. Une ligne sans numéro de projet est un frais général.
  PYBBIL: {
    table: 'PYBBIL',
    mappe: false, // passer à true une fois les noms de colonnes confirmés
    colonnes: {
      numeroSequence: { csv: 0,  bd: null },
      date:           { csv: 1,  bd: null },
      numeroFourn:    { csv: 2,  bd: null },
      numeroFacture:  { csv: 4,  bd: null },
      description:    { csv: 5,  bd: null },
      montantTotal:   { csv: 6,  bd: null },
      numeroProjet:   { csv: 33, bd: null },
      numeroCommande: { csv: 44, bd: null },
      nomFournisseur: { csv: 48, bd: null },
    },
    // 10 paires GL / montant : colonnes CSV 8/9, 10/11 ... 26/27.
    pairesGl: {
      nombre: 10,
      csvGlDepart: 8,
      csvMontantDepart: 9,
      csvPas: 2,
      bd: null, // ex. [{ gl: 'PBGL01', montant: 'PBMT01' }, ...]
    },
  },

  // Écritures : salariales (E) et bancaires (B).
  TRANS: {
    table: 'TRANS',
    mappe: false,
    colonnes: {
      numeroProjet:  { csv: 0, bd: null },
      numeroGl:      { csv: 1, bd: null },
      date:          { csv: 2, bd: null },
      journal:       { csv: 3, bd: null }, // 1er caractère = type (E, B, P)
      montant:       { csv: 4, bd: null },
      codeActivite:  { csv: 5, bd: null },
    },
  },

  // Facturation client — dénominateur de tout l'état des résultats.
  // Seule table dont les noms de colonnes sont déjà connus et vérifiés (export à en-tête).
  FACTMA: {
    table: 'FACTMA',
    mappe: true,
    colonnes: {
      numeroFacture: { csv: 'FFNOFACT', bd: 'FFNOFACT' },
      numeroProjet:  { csv: 'FFCONT',   bd: 'FFCONT' },
      client:        { csv: 'FFVENTE',  bd: 'FFVENTE' },
      date:          { csv: 'FFDATE',   bd: 'FFDATE' },
      montant:       { csv: 'FFTOTDU',  bd: 'FFTOTDU' },
      soldeOuvert:   { csv: 'FFSOLDE',  bd: 'FFSOLDE' },
      retenue:       { csv: 'FFMNTRET', bd: 'FFMNTRET' },
    },
  },

  // Fiches de projet — noms et clients.
  CONTRA: {
    table: 'CONTRA',
    mappe: true,
    colonnes: {
      numeroProjet: { csv: 'CONUM',     bd: 'CONUM' },
      nom:          { csv: 'CONOM',     bd: 'CONOM' },
      client:       { csv: 'COCLINOM',  bd: 'COCLINOM' },
      statut:       { csv: 'COSTT',     bd: 'COSTT' },
    },
  },

  // Libellés des divisions CSI.
  ACTIVE: {
    table: 'ACTIVE',
    mappe: false,
    colonnes: {
      code: { csv: 0, bd: null },
      nom:  { csv: 1, bd: null },
    },
  },

  // Rattache un numéro de commande à un code d'activité.
  COMITE: {
    table: 'COMITE',
    mappe: false,
    colonnes: {
      numeroCommande: { csv: 16, bd: null },
      codeActivite:   { csv: 17, bd: null },
    },
  },
};

// Retourne la liste des tables encore non mappées vers la base.
function tablesNonMappees() {
  return Object.keys(TABLES).filter(t => !TABLES[t].mappe);
}

// Une table est lisible en base si elle est mappée et que chaque colonne a un nom.
function estLisibleEnBd(nomTable) {
  const t = TABLES[nomTable];
  if (!t || !t.mappe) return false;
  return Object.values(t.colonnes).every(c => c.bd);
}

module.exports = { TABLES, tablesNonMappees, estLisibleEnBd };
