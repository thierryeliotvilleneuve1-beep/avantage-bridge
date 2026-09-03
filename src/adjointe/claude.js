// Rédaction des brouillons — Claude API (SDK officiel Anthropic).
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEME } = require('./redaction-prompt');
const { retirerTelephones } = require('./redact');

const MODELE = process.env.ADJOINTE_MODELE || 'claude-opus-5';

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY manquante');
    client = new Anthropic();
  }
  return client;
}

function contexte(item, corpsMessage, notes) {
  const l = [
    'COURRIEL REÇU',
    'De : ' + item.expediteur,
    'Objet : ' + item.sujet,
    'Reçu le : ' + item.recu_le,
    'Projet : ' + (item.projet || 'non identifié'),
    'Catégorie : ' + item.categorie,
    'Pièces jointes : ' + (item.pieces_jointes ? 'oui' : 'non'),
    '',
    'CORPS DU MESSAGE',
    retirerTelephones((corpsMessage || item.apercu || '').slice(0, 6000)),
  ];
  if (item.sujets_reserves.length) {
    l.push('', 'SUJETS RÉSERVÉS DÉTECTÉS : ' + item.sujets_reserves.join(', ') +
      ". Tu ne réponds pas sur ces points — tu accuses réception et tu annonces qu'un chargé de projet revient avec la réponse.");
  }
  if (notes) l.push('', 'CONSIGNES DE L’HUMAIN', notes);
  return l.join('\n');
}

function extraireJson(texte) {
  const debut = texte.indexOf('{');
  const fin = texte.lastIndexOf('}');
  if (debut === -1 || fin === -1) throw new Error('Réponse du modèle sans objet JSON');
  return JSON.parse(texte.slice(debut, fin + 1));
}

async function redigerBrouillon(item, corpsMessage, notes) {
  const reponse = await getClient().messages.create({
    model: MODELE,
    max_tokens: 4000,
    output_config: { effort: 'medium' },
    system: SYSTEME,
    messages: [{ role: 'user', content: contexte(item, corpsMessage, notes) }],
  });

  if (reponse.stop_reason === 'refusal') {
    throw new Error('Rédaction refusée par le modèle : ' +
      ((reponse.stop_details && reponse.stop_details.explanation) || 'sans détail'));
  }

  const texte = reponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = extraireJson(texte);
  return {
    objet: parsed.objet || 'RE: ' + item.sujet,
    corps: retirerTelephones(parsed.corps || ''),
    manques: Array.isArray(parsed.manques) ? parsed.manques : [],
    escalade: parsed.escalade || null,
    modele: MODELE,
    usage: reponse.usage,
  };
}

// Résumé court d'un fil pour le journal du vault — jamais de coordonnées personnelles.
async function resumerPourJournal(item, corpsMessage) {
  const reponse = await getClient().messages.create({
    model: MODELE,
    max_tokens: 700,
    output_config: { effort: 'low' },
    system: 'Tu résumes un courriel de chantier pour la mémoire d’entreprise de CRC. ' +
      'Une à trois phrases factuelles : décision technique, délai annoncé, refus, ou demande. ' +
      'Aucun numéro de téléphone, aucune adresse courriel personnelle, aucun montant. ' +
      'Réponds uniquement par le résumé, sans préambule.',
    messages: [{ role: 'user', content: contexte(item, corpsMessage) }],
  });
  const texte = reponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return retirerTelephones(texte);
}

module.exports = { redigerBrouillon, resumerPourJournal, MODELE };
