// Inbox Intel — Rattachement d'un courriel à un projet (multi-signaux).
// Le rattachement ne dépend PAS de qui est destinataire : un courriel est
// rattaché au projet même si la personne concernée est absente du fil.
//
// Signaux, du plus fort au plus faible :
//   1. code projet explicite dans objet/corps (P23020, 23020, #23020)
//   2. fil de conversation déjà rattaché (graph_conversation_id connu)
//   3. contact ↔ projet via LienEntite (à brancher après audit du schéma réel)
//   4. nom du projet/client dans le texte

const SEUIL_RATTACHEMENT = 0.6;

// Codes projet CRC observés : P23020 / 23020 (2 chiffres année + séquence).
const RE_CODE_PROJET = /\b(?:#|P)?(\d{5})\b/g;

function extraireCodesProjets(texte) {
  const codes = new Set();
  let m;
  while ((m = RE_CODE_PROJET.exec(texte)) !== null) {
    // Filtre grossier : les codes CRC commencent par l'année (2x). Évite de
    // capter des montants ou numéros de facture à 5 chiffres arbitraires.
    if (/^2\d{4}$/.test(m[1])) codes.add('P' + m[1]);
  }
  return [...codes];
}

/**
 * @param {object} courriel  { objet, corps, expediteur_email, graph_conversation_id }
 * @param {object} contexte  {
 *   projets: [{ _id, code_projet, nom }],            // depuis l'entité Projet
 *   conversationsConnues: { [conversation_id]: code_projet },
 *   liensContacts: { [email]: [code_projet] },       // depuis LienEntite (audit à faire)
 * }
 * @returns {{ code_projet, projet_id, confiance, signaux, statut }}
 */
function rattacherProjet(courriel, contexte = {}) {
  const projets = contexte.projets || [];
  const texte = `${courriel.objet || ''}\n${courriel.corps || ''}`;
  const signaux = [];
  let confiance = 0;
  let code = null;

  // 1. Code explicite dans le texte
  const codes = extraireCodesProjets(texte);
  const codesValides = codes.filter(c =>
    projets.some(p => normaliser(p.code_projet) === normaliser(c)));
  if (codesValides.length === 1) {
    code = codesValides[0];
    confiance += 0.85;
    signaux.push('code_dans_texte');
  } else if (codesValides.length > 1) {
    // Plusieurs projets cités → ambigu, validation manuelle.
    signaux.push('codes_multiples');
  }

  // 2. Fil de conversation déjà rattaché
  const parFil = (contexte.conversationsConnues || {})[courriel.graph_conversation_id];
  if (!code && parFil) {
    code = parFil;
    confiance += 0.75;
    signaux.push('fil_conversation');
  } else if (code && parFil && normaliser(parFil) === normaliser(code)) {
    confiance = Math.min(1, confiance + 0.1);
    signaux.push('fil_conversation');
  }

  // 3. Contact connu via LienEntite
  const parContact = (contexte.liensContacts || {})[String(courriel.expediteur_email || '').toLowerCase()] || [];
  if (!code && parContact.length === 1) {
    code = parContact[0];
    confiance += 0.55;
    signaux.push('lien_entite_contact');
  } else if (code && parContact.some(c => normaliser(c) === normaliser(code))) {
    confiance = Math.min(1, confiance + 0.1);
    signaux.push('lien_entite_contact');
  }

  // 4. Nom du projet dans le texte
  if (!code) {
    const parNom = projets.find(p => p.nom && p.nom.length > 4 &&
      texte.toLowerCase().includes(p.nom.toLowerCase()));
    if (parNom) {
      code = parNom.code_projet;
      confiance += 0.5;
      signaux.push('nom_projet');
    }
  }

  const projet = code
    ? projets.find(p => normaliser(p.code_projet) === normaliser(code))
    : null;
  confiance = Number(Math.min(1, confiance).toFixed(2));

  return {
    code_projet: projet ? projet.code_projet : code,
    projet_id: projet ? projet._id : null,
    confiance,
    signaux,
    statut: code && confiance >= SEUIL_RATTACHEMENT ? 'nouveau' : 'a_rattacher',
  };
}

function normaliser(c) {
  return String(c || '').replace(/^P/i, '').replace(/^0+/, '');
}

module.exports = { rattacherProjet, extraireCodesProjets, SEUIL_RATTACHEMENT };
