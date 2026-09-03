// Adjointe IA — configuration centrale
// Source de vérité de la gouvernance : vault-CRC-Memoire/00-Gouvernance/Mandat-Agent-Adjointe.md
//                                       vault-CRC-Memoire/00-Gouvernance/Procedure-Alimentation-Courriels.md

const MAILBOX = process.env.ADJOINTE_MAILBOX || 'projets@c-rc.ca';

// Niveaux d'autonomie — voir docs/ADJOINTE-IA.md
// N0 lecture+classement en mémoire | N1 catégories Outlook | N2 brouillons | N3 envoi restreint
const NIVEAU = parseInt(process.env.ADJOINTE_NIVEAU || '0', 10);

// Projets actifs — repris de Procedure-Alimentation-Courriels.md §2
const PROJETS_ACTIFS = [
  'P26011', 'P26010', 'P26008', 'P26007', 'P26006', 'P26004',
  'P25019', 'P25017', 'P25016', 'P25015', 'P25011', 'P25010', 'P25007', 'P25005',
  'P24020', 'P24015', 'P24014', 'P22005',
];

// Dossiers jamais traités en autonomie (litige, réclamation) — Procedure §6
const PROJETS_SENSIBLES = ['P24020', 'P25007', 'P25019'];

// Adresses internes CRC — un message interne n'est jamais une communication externe
const DOMAINE_INTERNE = 'c-rc.ca';

// Destinataires d'escalade
const ESCALADE = {
  cp: process.env.ADJOINTE_CP_EMAIL || 'c.milot@c-rc.ca',
  direction: 't.villeneuve@c-rc.ca',
};

// Signature apposée aux brouillons sortants
// Note : le guide de marque porte le 418 365-7788 comme ligne principale;
// la directive organisationnelle CRC impose le 418-365-7973 pour la coordination de projets.
const SIGNATURE = {
  service: 'Coordination de projets',
  entreprise: 'Construction Richard Champagne inc.',
  telephone: '418-365-7973',
  courriel: MAILBOX,
  rbq: '8231-1127-01',
};

// Marque CRC
const MARQUE = {
  rougeFonce: '#8D0005',
  rougeVif: '#DD101B',
  noir: '#0A0A0A',
  grisMoyen: '#828182',
  grisClair: '#C4C4C4',
};

// Stockage local
const path = require('path');
const DATA_DIR = process.env.ADJOINTE_DATA_DIR || path.resolve(__dirname, '../../data-adjointe');

// Vault (écriture directe sur disque, synchronisé par OneDrive) — Procedure §0
const VAULT_DIR = process.env.VAULT_DIR || '';

module.exports = {
  MAILBOX, NIVEAU, PROJETS_ACTIFS, PROJETS_SENSIBLES, DOMAINE_INTERNE,
  ESCALADE, SIGNATURE, MARQUE, DATA_DIR, VAULT_DIR,
};
