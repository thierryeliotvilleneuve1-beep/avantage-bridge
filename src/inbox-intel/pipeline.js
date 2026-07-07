// Inbox Intel — Pipeline : courriel → classification → EvenementTimeline
// → ActionSuggeree (en attente de décision du CP).
//
// Aucune action ne s'exécute automatiquement : la sortie est toujours une
// suggestion avec statut `en_attente`.

const { classifier } = require('./classifier');
const { rattacherProjet } = require('./projet-matcher');

// Action suggérée de repli quand le LLM n'est pas branché : composée à partir
// de signaux du CONTENU (échéance, question, montant, demande d'approbation),
// pas d'un gabarit figé par type de document.
function suggererActionHeuristique(courriel, classification) {
  const texte = `${courriel.objet || ''}\n${courriel.corps || ''}`;
  const morceaux = [];
  let priorite = 'normale';

  const echeance = texte.match(/\b(?:avant|d['']ici|au plus tard)\s+(le\s+)?([\d]{1,2}\s+\w+(\s+\d{4})?|\d{4}-\d{2}-\d{2})/i);
  const question = /\?/.test(texte) || /pouvez[- ]vous|merci de (nous )?(confirmer|répondre|préciser)/i.test(texte);
  const approbation = /pour\s+approbation|approuver|approbation requise/i.test(texte);
  const montant = texte.match(/\$?\s?([\d]{1,3}(?:[\s,][\d]{3})*(?:[.,]\d{2})?)\s?\$/);
  const urgence = /\burgent|dès que possible|ASAP|immédiat/i.test(texte);

  if (approbation) { morceaux.push('réviser le document et retourner l’approbation (ou les annotations)'); }
  if (question) { morceaux.push('répondre à la demande de l’expéditeur'); }
  if (montant) { morceaux.push(`vérifier le montant mentionné (${montant[0].trim()}) contre le contrat/bon de commande`); }
  if (classification.type_document === 'retard') { morceaux.push('évaluer l’impact sur l’échéancier et aviser les intervenants touchés'); }
  if (classification.type_document === 'reclamation') { morceaux.push('documenter la réclamation et valider la position contractuelle'); priorite = 'haute'; }
  if (morceaux.length === 0) { morceaux.push('prendre connaissance du courriel et classer au dossier projet'); priorite = 'basse'; }

  let echeance_suggeree = null;
  if (echeance) { morceaux.push(`échéance mentionnée : « ${echeance[0].trim()} »`); priorite = priorite === 'basse' ? 'normale' : 'haute'; }
  if (urgence) priorite = 'urgente';

  return {
    description_action: morceaux[0].charAt(0).toUpperCase() + morceaux.join(' ; ').slice(1) + '.',
    justification: `Déduit du contenu : ${classification.preuves && classification.preuves.length ? classification.preuves.join(', ') : 'aucun indice fort, courriel général'}.`,
    priorite,
    echeance_suggeree,
  };
}

/**
 * Traite un courriel et produit les deux objets prêts à écrire dans Base44.
 * @param {object} courriel  format samples/courriels-test.json
 * @param {object} contexte  { projets, conversationsConnues, liensContacts,
 *                             cpParProjet: { [code_projet]: email }, llmAdapter }
 */
async function traiterCourriel(courriel, contexte = {}) {
  const classification = await classifier(courriel, contexte.llmAdapter);
  const rattachement = rattacherProjet(courriel, contexte);

  const evenement = {
    projet_id: rattachement.projet_id,
    code_projet: rattachement.code_projet,
    type_evenement: courriel.sortant ? 'courriel_sortant' : 'courriel_entrant',
    type_document: classification.type_document,
    date_evenement: courriel.date,
    expediteur_email: courriel.expediteur_email,
    expediteur_nom: courriel.expediteur_nom,
    destinataires: courriel.destinataires || [],
    cc: courriel.cc || [],
    objet: courriel.objet,
    resume_court: classification.resume_court,
    pieces_jointes: courriel.pieces_jointes || [],
    boite_source: courriel.boite_source || null,
    graph_message_id: courriel.graph_message_id || null,
    internet_message_id: courriel.internet_message_id || null,
    graph_conversation_id: courriel.graph_conversation_id || null,
    confiance_classification: classification.confiance,
    methode_classification: classification.methode,
    confiance_rattachement: rattachement.confiance,
    signaux_rattachement: rattachement.signaux,
    statut: rattachement.statut,
  };

  // Action suggérée : le LLM fournit la sienne ; sinon repli heuristique.
  const base = classification.action_suggeree
    ? {
        description_action: classification.action_suggeree,
        justification: classification.justification || '',
        priorite: classification.priorite || 'normale',
        echeance_suggeree: classification.echeance_suggeree || null,
      }
    : suggererActionHeuristique(courriel, classification);

  const cp = (contexte.cpParProjet || {})[evenement.code_projet] || null;
  const action = {
    // evenement_id est rempli après création de l'événement dans Base44.
    code_projet: evenement.code_projet,
    projet_id: evenement.projet_id,
    ...base,
    cp_email: cp, // CP du projet notifié en premier ; jamais le VP ops sans escalade
    statut: 'en_attente',
    escalade: false,
  };

  return { evenement, action };
}

module.exports = { traiterCourriel, suggererActionHeuristique };
