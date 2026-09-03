// Moteur de triage — classification déterministe des courriels de projets@c-rc.ca
// Règles issues de Procedure-Alimentation-Courriels.md §3 (bruit), §4 (valeur), annexes.
const { PROJETS_ACTIFS, PROJETS_SENSIBLES, DOMAINE_INTERNE } = require('./config');

const RE_PROJET = /\bP\s?-?(2[0-9])\s?-?(\d{3})\b/gi;
const RE_QRT = /\bQRT\s*#?\s*(\d{1,3})?/i;
const RE_DIRECTIVE = /\b(directive|DDC|DDI)\b/i;
const RE_ODC = /\b(ODC|ordre de changement|avenant)\b/i;
const RE_BC = /\b(bon de commande|\bBC\s*#?\s*\d+|PO\s*#?\s*\d+)/i;
const RE_FACTURE = /\b(facture|DDP\d*|demande de paiement|note de cr[ée]dit)\b/i;
const RE_SOUMISSION = /\b(invitation [àa] soumissionner|appel d'offres|soumission|addenda)\b/i;
const RE_DELAI = /\b(\d+\s*semaines?|d[ée]lai|[ée]ch[ée]ancier|retard|livraison|fabrication|vacances de la construction)\b/i;
const RE_PRIX = /\b(prix|montant|co[ûu]t|\$|tarif|honoraires|plus-value|cr[ée]dit)\b/i;
const RE_PORTEE = /\b(port[ée]e|exclusion|inclus|non inclus|hors contrat|extra)\b/i;
const RE_RELANCE = /\b(relance|rappel|toujours en attente|sans r[ée]ponse|urgent|suivi de ma demande)\b/i;
const RE_DOC_ATTENDU = /\b(dessins? d'atelier|fiche technique|attestation|CNESST|CCQ|assurance|RBQ|quittance|d[ée]nonciation)\b/i;
const RE_RECLAMATION = /\b(r[ée]clamation|mise en demeure|procureur|avocat|litige|non-conformit[ée]|d[ée]ficience)\b/i;

// Bruit — §3 et annexe
const EXPEDITEURS_BRUIT = [
  'backup@itcloudbackup.ca', 'no-reply@outlook.mail.microsoft', 'noreply@fieldwire.com',
  'no-reply@constructbuy.com', 'notifications@read.ai',
];
const RE_ACCUSE_LECTURE = /^(lu\s*:|read\s*:|non lu\s*:|not read\s*:)/i;
const RE_AUTO = /\b(confirmation de commande|avis de livraison|bordereau d'exp[ée]dition|infolettre|se d[ée]sabonner|facturation d'abonnement|traitement des plans termin[ée])\b/i;
const RE_PTI = /^\s*PTI\b/i;

function normaliserCodeProjet(txt) {
  const codes = new Set();
  let m;
  RE_PROJET.lastIndex = 0;
  while ((m = RE_PROJET.exec(txt || '')) !== null) codes.add(('P' + m[1] + m[2]).toUpperCase());
  return [...codes];
}

function detecterProjet(msg) {
  const champ = [msg.subject, msg.bodyPreview].filter(Boolean).join(' ');
  const codes = normaliserCodeProjet(champ);
  const actif = codes.find((c) => PROJETS_ACTIFS.includes(c));
  return actif || codes[0] || null;
}

function estInterne(adresse) {
  return (adresse || '').toLowerCase().endsWith('@' + DOMAINE_INTERNE);
}

function adresseExpediteur(msg) {
  return ((msg.from && msg.from.emailAddress && msg.from.emailAddress.address) || '').toLowerCase();
}

function estBruit(msg) {
  const sujet = msg.subject || '';
  const exp = adresseExpediteur(msg);
  if (RE_ACCUSE_LECTURE.test(sujet)) return 'accusé de lecture';
  if (EXPEDITEURS_BRUIT.some((e) => exp.includes(e))) return 'notification de plateforme';
  if (RE_AUTO.test(sujet)) return 'notification automatique';
  if (RE_PTI.test(sujet) && !(msg.bodyPreview || '').trim()) return 'transfert PTI sans contenu';
  return null;
}

// Catégories métier
function categoriser(msg) {
  const t = [msg.subject, msg.bodyPreview].filter(Boolean).join(' ');
  if (RE_RECLAMATION.test(t)) return 'reclamation';
  if (RE_QRT.test(t)) return 'qrt';
  if (RE_ODC.test(t)) return 'odc';
  if (RE_DIRECTIVE.test(t)) return 'directive';
  if (RE_FACTURE.test(t)) return 'facturation';
  if (RE_BC.test(t)) return 'bon_de_commande';
  if (RE_SOUMISSION.test(t)) return 'developpement_affaires';
  if (RE_DOC_ATTENDU.test(t)) return 'document_attendu';
  if (RE_RELANCE.test(t)) return 'relance';
  return 'coordination';
}

// Sujets réservés — RACI : délai, portée, prix → jamais de réponse autonome
function sujetsReserves(msg) {
  const t = [msg.subject, msg.bodyPreview].filter(Boolean).join(' ');
  const r = [];
  if (RE_PRIX.test(t)) r.push('prix');
  if (RE_DELAI.test(t)) r.push('delai');
  if (RE_PORTEE.test(t)) r.push('portee');
  return r;
}

function urgence(msg, categorie) {
  if (msg.importance === 'high') return 'haute';
  if (categorie === 'reclamation') return 'haute';
  if (RE_RELANCE.test(msg.subject || '')) return 'haute';
  const age = (Date.now() - new Date(msg.receivedDateTime).getTime()) / 86400000;
  if (age > 3) return 'haute';
  if (age > 1) return 'moyenne';
  return 'normale';
}

// Signaux à ne jamais manquer — annexe de la procédure
function signaux(msg) {
  const t = [msg.subject, msg.bodyPreview].filter(Boolean).join(' ');
  const s = [];
  if (/\bcarte personnelle\b/i.test(t)) s.push('achat sur carte personnelle — hors contrôle budgétaire');
  if (/vacances de la construction/i.test(t)) s.push('vacances de la construction — décalage d’échéancier');
  if (/\b\d+\s*semaines?\b/i.test(t)) s.push('délai de fabrication ou de livraison annoncé');
  if (/\b(procureur|avocat|mise en demeure)\b/i.test(t)) s.push('entrée juridique au dossier');
  if (/\brefus[ée]?\b/i.test(t)) s.push('refus d’un produit ou d’une méthode');
  return s;
}

function trier(msg) {
  const bruit = estBruit(msg);
  const projet = detecterProjet(msg);
  const expediteur = adresseExpediteur(msg);
  const categorie = bruit ? 'bruit' : categoriser(msg);
  const reserves = bruit ? [] : sujetsReserves(msg);

  return {
    id: msg.id,
    conversationId: msg.conversationId,
    internetMessageId: msg.internetMessageId,
    sujet: msg.subject || '(sans objet)',
    expediteur,
    expediteur_interne: estInterne(expediteur),
    destinataires: (msg.toRecipients || []).map((r) => r.emailAddress.address),
    recu_le: msg.receivedDateTime,
    apercu: (msg.bodyPreview || '').slice(0, 400),
    pieces_jointes: !!msg.hasAttachments,
    webLink: msg.webLink,
    projet,
    projet_sensible: !!projet && PROJETS_SENSIBLES.includes(projet),
    projet_actif: !!projet && PROJETS_ACTIFS.includes(projet),
    categorie,
    bruit,
    sujets_reserves: reserves,
    urgence: bruit ? 'nulle' : urgence(msg, categorie),
    signaux: bruit ? [] : signaux(msg),
  };
}

module.exports = { trier, detecterProjet, categoriser, estBruit, normaliserCodeProjet, sujetsReserves };
