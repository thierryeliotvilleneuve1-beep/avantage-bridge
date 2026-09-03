// Garde-fous — traduit en code le Mandat-Agent-Adjointe et le RACI du vault.
// Aucune de ces règles ne doit être contournée par la génération de texte.
const { NIVEAU, PROJETS_SENSIBLES, DOMAINE_INTERNE } = require('./config');

const NIVEAUX = {
  0: 'Observation — lecture et classement en mémoire seulement',
  1: 'Classement — catégories Outlook appliquées à la boîte',
  2: 'Brouillons — réponses préparées dans Brouillons, jamais envoyées',
  3: 'Envoi restreint — envoi automatique des seuls accusés de réception',
};

// Catégories dont une réponse peut être rédigée sans intervention du CP.
const CATEGORIES_BROUILLON = ['relance', 'document_attendu', 'coordination', 'developpement_affaires'];

// Catégories admissibles à l'envoi automatique au niveau 3 — accusé de réception pur.
const CATEGORIES_ENVOI_AUTO = ['document_attendu'];

// Décide de l'action permise pour un élément trié.
function decider(item, niveau = NIVEAU) {
  const blocages = [];

  if (item.bruit) {
    return { action: 'classer', motif: item.bruit, blocages, escalade: null };
  }
  if (item.projet_sensible) {
    blocages.push('projet sensible (litige ou réclamation) — Procedure §6');
  }
  if (item.categorie === 'reclamation') {
    blocages.push('réclamation, différend ou mise en demeure');
  }
  if (item.sujets_reserves.length) {
    blocages.push('touche ' + item.sujets_reserves.join(', ') + ' — RACI : approbation humaine obligatoire');
  }
  if (['odc', 'directive', 'bon_de_commande', 'facturation'].includes(item.categorie)) {
    blocages.push('engagement contractuel ou financier — décision réservée au CP');
  }
  if (!item.projet) {
    blocages.push('aucun code de projet identifié');
  }

  if (blocages.length) {
    return {
      action: 'escalader',
      motif: blocages[0],
      blocages,
      escalade: item.categorie === 'reclamation' || item.projet_sensible ? 'direction' : 'cp',
    };
  }

  if (niveau >= 2 && CATEGORIES_BROUILLON.includes(item.categorie)) {
    const auto = niveau >= 3 && CATEGORIES_ENVOI_AUTO.includes(item.categorie) &&
      !item.pieces_jointes && item.urgence !== 'haute';
    return { action: auto ? 'repondre_auto' : 'brouillon', motif: null, blocages, escalade: null };
  }

  return { action: 'classer', motif: 'niveau d’autonomie ' + niveau, blocages, escalade: null };
}

// Dernier filet avant toute écriture sortante : un brouillon ne part jamais
// vers l'externe s'il porte une donnée financière ou un engagement de délai.
function validerBrouillon(item, texte) {
  const erreurs = [];
  const externe = !item.expediteur_interne &&
    !(item.expediteur || '').endsWith('@' + DOMAINE_INTERNE);
  if (externe && /\d[\d\s.,]*\s?\$|\$\s?\d/.test(texte)) {
    erreurs.push('montant détecté dans un brouillon externe');
  }
  if (/\b(nous (confirmons|nous engageons)|c'est approuv[ée]|autoris[ée])\b/i.test(texte)) {
    erreurs.push('formulation d’engagement — interdit sans validation humaine');
  }
  if (PROJETS_SENSIBLES.includes(item.projet)) {
    erreurs.push('projet sensible — aucun brouillon automatique');
  }
  return { valide: erreurs.length === 0, erreurs };
}

module.exports = { NIVEAUX, decider, validerBrouillon, CATEGORIES_BROUILLON, CATEGORIES_ENVOI_AUTO };
