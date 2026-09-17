// Mapping logique -> colonnes Avantage.
// "names" = noms de colonnes connus (repris des exports Avantage deja exploites).
// "match" = fragments utilises pour resoudre automatiquement une colonne dont le
// nom exact n'est pas encore connu. discover-db.js fige le resultat dans
// config/avantage-schema.local.json.
const SCHEMA = {
  // Projets
  projets: {
    table: 'CONTRA',
    columns: {
      numero:          { names: ['CONUM'],                 match: ['conum', 'nocontrat', 'noprojet'] },
      nom:             { names: ['CONOM', 'CONOMS'],       match: ['conom', 'nom'] },
      client:          { names: ['COCLINOM', 'COCLI'],     match: ['cocli', 'client'] },
      statut:          { names: ['COSTT'],                 match: ['costt', 'statut'] },
      date_debut:      { names: ['COFADATER'],             match: ['cofadater'] },
      date_fin_prevue: { names: ['COFADATEP'],             match: ['cofadatep'] },
      solde:           { names: ['COSOLDER'],              match: ['cosolder'] },
      profit:          { names: ['COPRCPROF'],             match: ['coprcprof'] },
    },
  },
  // Factures client
  facturesClient: {
    table: 'FACTMA',
    columns: {
      numero_facture: { names: ['FFNOFACT'], match: ['nofact'] },
      projet:         { names: ['FFCONT'],   match: ['ffcont', 'contrat'] },
      client:         { names: ['FFVENTE', 'FFNOM'], match: ['ffvente', 'ffnom'] },
      date:           { names: ['FFDATE'],   match: ['ffdate'] },
      date_echeance:  { names: ['FFDATEP'],  match: ['ffdatep'] },
      total:          { names: ['FFTOTDU'],  match: ['fftotdu', 'total'] },
      solde:          { names: ['FFSOLDE'],  match: ['ffsolde', 'solde'] },
      retenue:        { names: ['FFMNTRET'], match: ['ffmntret', 'retenue'] },
    },
  },
  // Budget previsionnel par activite
  budget: {
    table: 'CONPRE',
    columns: {
      projet:   { names: ['CPCONUM'], match: ['cpconum', 'projet', 'contrat'] },
      activite: { names: ['CPACT'],   match: ['cpact', 'activit'] },
      montant:  { names: ['CPMNT'],   match: ['cpmnt', 'visionnel', 'montant'] },
    },
  },
  // Facture au client par activite
  facturationActivite: {
    table: 'CONACT',
    columns: {
      projet:          { names: ['CACONUM'], match: ['caconum', 'projet', 'contrat'] },
      activite:        { names: ['CAANUM'],  match: ['caanum', 'activit'] },
      facture:         { names: ['CAFACT'],  match: ['cafact'] },
      depense_a_venir: { names: ['CAVENIR'],  match: ['cavenir'] },
    },
  },
  // Activites (divisions)
  activites: {
    table: 'ACTIVE',
    columns: {
      code: { names: ['ACNUM', 'ANUM'],  match: ['acnum', 'anum', 'activit', 'code'] },
      nom:  { names: ['ACDESC', 'ADESC'], match: ['desc', 'nom'] },
    },
  },
  // Transactions du grand livre projet
  transactions: {
    table: 'TRANS',
    columns: {
      projet:   { names: [], match: ['conum', 'projet', 'contrat'] },
      gl:       { names: [], match: ['gl', 'compte'] },
      date:     { names: [], match: ['date'] },
      journal:  { names: [], match: ['journal', 'jrnl', 'noseq', 'seq'] },
      montant:  { names: [], match: ['mnt', 'montant'] },
      activite: { names: [], match: ['act', 'activit'] },
    },
  },
  // Factures fournisseurs (comptes a payer)
  facturesFournisseur: {
    table: 'PYBBIL',
    columns: {
      seq:           { names: [], match: ['noseq', 'seq'] },
      date:          { names: [], match: ['date'] },
      no_facture:    { names: [], match: ['nofact', 'facture'] },
      description:   { names: [], match: ['desc'] },
      montant_total: { names: [], match: ['tot', 'mnt'] },
      projet:        { names: [], match: ['conum', 'projet', 'contrat'] },
      no_commande:   { names: [], match: ['commande', 'nocmd', 'cmd'] },
      fournisseur:   { names: [], match: ['fourn', 'nom'] },
    },
    // Paires GL/montant de ventilation: colonnes GL1..GL10 et MNT1..MNT10.
    ventilation: { gl: 'GL', montant: 'MNT', count: 10 },
  },
  // Lignes de bon de commande
  commandeItems: {
    table: 'COMITE',
    columns: {
      no_commande: { names: [], match: ['commande', 'nocmd', 'cmd', 'seq'] },
      activite:    { names: [], match: ['act', 'activit'] },
    },
  },
  // Entetes de bons de commande
  commandes: {
    table: 'COMMAN',
    columns: {
      projet:         { names: [], match: ['conum', 'projet', 'contrat'] },
      seq:            { names: [], match: ['noseq', 'sequentiel', 'seq'] },
      seq_commande:   { names: [], match: ['nocmd', 'commande'] },
      no_fournisseur: { names: [], match: ['fourn'] },
      nom_fournisseur:{ names: [], match: ['nomfourn', 'nom'] },
      sous_total:     { names: [], match: ['soustot', 'sstot', 'tot', 'mnt'] },
      statut:         { names: [], match: ['statut', 'stt'] },
    },
  },
};

module.exports = { SCHEMA };
