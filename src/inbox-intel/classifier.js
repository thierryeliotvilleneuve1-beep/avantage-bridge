// Inbox Intel — Classification par analyse du contenu (objet + corps).
// Deux moteurs : LLM (moteur cible, voir llm-adapter.js) et heuristique
// (repli hors-ligne / développement). Aucune règle sur l'expéditeur :
// uniquement le contenu.

const TYPES = [
  'dessin_atelier',
  'facture',
  'rfi',
  'retard',
  'reclamation',
  'directive_chantier',
  'general',
];

// Indices lexicaux pondérés, français (usage QC) + anglais courant en
// construction. Un indice "fort" pèse 3, "moyen" 2, "faible" 1.
const INDICES = {
  dessin_atelier: {
    fort: [/dessins?\s+d['']atelier/i, /shop\s*drawings?/i, /\bDA[-\s]?\d+/i],
    moyen: [/pour\s+approbation/i, /soumission\s+de\s+dessins?/i, /\bsoumis\s+pour\s+(révision|approbation)/i],
    faible: [/\brévision\s+[A-Z0-9]\b/i, /annoté/i, /\bplans?\b/i],
  },
  facture: {
    fort: [/\bfactures?\b/i, /\binvoices?\b/i, /\bfacturation\b/i],
    moyen: [/montant\s+(dû|à\s+payer)/i, /solde\s+(ouvert|impayé)/i, /état\s+de\s+compte/i],
    faible: [/\bpaiement\b/i, /\$\s?[\d\s,.]+/, /\btaxes?\b/i],
  },
  rfi: {
    fort: [/\bRFI\b/, /demande\s+d['']informations?/i, /demande\s+de\s+renseignements?/i],
    moyen: [/question\s+technique/i, /clarifications?/i, /préciser\s+le\s+détail/i],
    faible: [/pouvez[- ]vous\s+(nous\s+)?(confirmer|préciser)/i],
  },
  retard: {
    fort: [/\bretards?\b/i, /\bdélais?\s+(supplémentaire|de\s+livraison|prolongé)/i, /livraison\s+(reportée|repoussée|retardée)/i],
    moyen: [/échéancier\s+(révisé|impacté)/i, /reporté[e]?\s+au/i, /rupture\s+de\s+stock/i],
    faible: [/nouvelle\s+date/i, /\bdélai\b/i],
  },
  reclamation: {
    fort: [/\bréclamations?\b/i, /\bclaims?\b/i, /avis\s+de\s+réclamation/i],
    moyen: [/coûts?\s+(additionnels?|supplémentaires?)/i, /\bextras?\b/i, /dommages?/i, /mise\s+en\s+demeure/i],
    faible: [/impact\s+(monétaire|financier)/i, /compensation/i],
  },
  directive_chantier: {
    fort: [/directives?\s+de\s+chantier/i, /\bDC[-\s]?\d+/i, /ordre\s+de\s+changement/i, /\bODC\b/],
    moyen: [/\bavenant\b/i, /instruction\s+de\s+chantier/i, /modification\s+au\s+contrat/i],
    faible: [/veuillez\s+procéder/i],
  },
};

function scoreType(texte, indices) {
  let score = 0;
  const preuves = [];
  for (const [poids, patterns] of [[3, indices.fort], [2, indices.moyen], [1, indices.faible]]) {
    for (const p of patterns) {
      const m = texte.match(p);
      if (m) { score += poids; preuves.push(m[0].trim()); }
    }
  }
  return { score, preuves };
}

// Classification heuristique. Retourne { type_document, confiance, preuves, methode }.
function classifierHeuristique(courriel) {
  const texte = `${courriel.objet || ''}\n${courriel.corps || ''}`;
  let meilleur = { type: 'general', score: 0, preuves: [] };
  for (const [type, indices] of Object.entries(INDICES)) {
    const { score, preuves } = scoreType(texte, indices);
    if (score > meilleur.score) meilleur = { type, score, preuves };
  }
  // Confiance : 0 indice → général à 0.5 ; saturation autour de 8 points.
  const confiance = meilleur.score === 0 ? 0.5 : Math.min(0.95, 0.4 + meilleur.score * 0.07);
  return {
    type_document: meilleur.score === 0 ? 'general' : meilleur.type,
    confiance: Number(confiance.toFixed(2)),
    preuves: meilleur.preuves,
    methode: 'heuristique',
  };
}

// Résumé court de repli (le LLM produit le vrai résumé) : première phrase
// significative du corps, tronquée.
function resumeHeuristique(courriel) {
  const corps = (courriel.corps || '').replace(/\s+/g, ' ').trim();
  const phrase = corps.split(/(?<=[.!?])\s/)[0] || courriel.objet || '';
  return phrase.length > 180 ? phrase.slice(0, 177) + '…' : phrase;
}

// Point d'entrée : tente le LLM, retombe sur l'heuristique.
async function classifier(courriel, llmAdapter) {
  if (llmAdapter && llmAdapter.disponible()) {
    const r = await llmAdapter.analyser(courriel);
    if (r) return r; // { type_document, confiance, resume_court, ... methode: 'llm' }
  }
  const h = classifierHeuristique(courriel);
  return { ...h, resume_court: resumeHeuristique(courriel) };
}

module.exports = { TYPES, classifier, classifierHeuristique, resumeHeuristique };
