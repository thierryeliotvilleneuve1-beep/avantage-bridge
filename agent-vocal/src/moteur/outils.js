// Outils que l'agent vocal peut appeler pendant un appel.
// Chaque outil expose un schema (pour Claude) et un executeur (cote serveur).

const { store } = require('../db');
const horaire = require('../horaire');

/** Construit la liste des outils disponibles selon la configuration du client. */
function definitions(client) {
  const destinataires = client.equipe.map((m) => m.nom);
  const outils = [
    {
      name: 'consulter_infos',
      description:
        "Repond a une question factuelle sur l'entreprise a partir de sa fiche : heures " +
        "d'ouverture, adresse, services offerts, questions frequentes. Appeler cet outil " +
        "avant de repondre a toute question sur l'entreprise plutot que de deviner.",
      input_schema: {
        type: 'object',
        properties: {
          sujet: {
            type: 'string',
            enum: ['heures', 'adresse', 'services', 'faq', 'coordonnees'],
            description: 'Categorie d\'information demandee.',
          },
          question: {
            type: 'string',
            description: "Question exacte de l'appelant, utilisee pour chercher dans la FAQ.",
          },
        },
        required: ['sujet'],
      },
    },
    {
      name: 'prendre_message',
      description:
        "Enregistre un message pour l'equipe. Appeler quand l'appelant veut laisser un " +
        "message, quand la personne demandee n'est pas joignable, ou en dehors des heures " +
        "d'ouverture. Recueillir le nom et un numero de rappel avant d'appeler cet outil.",
      input_schema: {
        type: 'object',
        properties: {
          nom: { type: 'string', description: "Nom complet de l'appelant." },
          telephone: { type: 'string', description: 'Numero de rappel, chiffres seulement.' },
          courriel: { type: 'string', description: 'Courriel si fourni.' },
          objet: { type: 'string', description: 'Objet en quelques mots.' },
          contenu: { type: 'string', description: 'Message complet, dans les mots de l\'appelant.' },
          urgence: {
            type: 'string',
            enum: ['normale', 'elevee', 'urgente'],
            description: "Urgence percue. « urgente » declenche une alerte immediate.",
          },
          destinataire: {
            type: 'string',
            description: `Personne visee si precisee. Valeurs possibles : ${destinataires.join(', ') || 'aucune'}.`,
          },
        },
        required: ['nom', 'telephone', 'objet', 'contenu'],
      },
    },
  ];

  if (client.equipe.length || client.numero_transfert_defaut) {
    outils.push({
      name: 'transferer_appel',
      description:
        "Transfere l'appel en direct vers un membre de l'equipe. N'appeler que pendant les " +
        "heures d'ouverture et lorsque l'appelant demande a parler a quelqu'un ou que le " +
        "sujet exige un humain. Annoncer le transfert a l'appelant avant d'appeler cet outil.",
      input_schema: {
        type: 'object',
        properties: {
          destinataire: {
            type: 'string',
            description: `Nom du membre de l'equipe, ou « reception » pour la ligne principale. Membres : ${destinataires.join(', ') || 'aucun'}.`,
          },
          raison: { type: 'string', description: 'Motif du transfert, en une phrase.' },
        },
        required: ['destinataire', 'raison'],
      },
    });
  }

  if (client.rdv && client.rdv.actif) {
    outils.push(
      {
        name: 'verifier_disponibilites',
        description:
          'Liste les plages libres pour un rendez-vous a une date donnee. Toujours appeler ' +
          'cet outil avant de proposer une heure a l\'appelant.',
        input_schema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Date visee, format AAAA-MM-JJ.' },
          },
          required: ['date'],
        },
      },
      {
        name: 'prendre_rendez_vous',
        description:
          'Confirme un rendez-vous dans une plage verifiee au prealable avec ' +
          'verifier_disponibilites. Repeter la date et l\'heure a l\'appelant avant de confirmer.',
        input_schema: {
          type: 'object',
          properties: {
            nom: { type: 'string' },
            telephone: { type: 'string' },
            courriel: { type: 'string' },
            date: { type: 'string', description: 'Format AAAA-MM-JJ.' },
            heure: { type: 'string', description: 'Format HH:MM sur 24 heures.' },
            objet: { type: 'string', description: 'Motif du rendez-vous.' },
          },
          required: ['nom', 'telephone', 'date', 'heure', 'objet'],
        },
      }
    );
  }

  if (client.urgences && client.urgences.numero) {
    outils.push({
      name: 'escalader_urgence',
      description:
        "Achemine immediatement un appel d'urgence vers la ligne d'urgence, a toute heure. " +
        `N'appeler que pour une situation correspondant a : ${(client.urgences.mots_cles || []).join(', ')}.`,
      input_schema: {
        type: 'object',
        properties: {
          nature: { type: 'string', description: "Nature de l'urgence." },
          lieu: { type: 'string', description: 'Adresse ou chantier concerne, si connu.' },
          rappel: { type: 'string', description: 'Numero de rappel de l\'appelant.' },
        },
        required: ['nature'],
      },
    });
  }

  outils.push({
    name: 'terminer_appel',
    description:
      "Met fin a l'appel. Appeler apres avoir salue l'appelant, une fois sa demande traitee, " +
      "ou lorsqu'il s'agit d'une sollicitation commerciale non desiree.",
    input_schema: {
      type: 'object',
      properties: {
        categorie: {
          type: 'string',
          enum: ['client', 'fournisseur', 'sollicitation', 'erreur', 'autre'],
          description: "Nature de l'appel.",
        },
        resume: { type: 'string', description: "Resume de l'appel en une ou deux phrases." },
      },
      required: ['categorie', 'resume'],
    },
  });

  return outils;
}

/**
 * Execute un outil.
 * @returns {{resultat: string, action?: object}} `resultat` retourne a Claude,
 *          `action` interprete par la session (transfert, raccrochage...).
 */
function executer(nom, entree, contexte) {
  const { client, appelId } = contexte;

  switch (nom) {
    case 'consulter_infos':
      return { resultat: consulterInfos(client, entree) };

    case 'prendre_message': {
      const destinataire = trouverMembre(client, entree.destinataire);
      store.ajouterMessage({
        appel_id: appelId,
        client_id: client.id,
        nom: entree.nom || null,
        telephone: entree.telephone || null,
        courriel: entree.courriel || null,
        objet: entree.objet || null,
        contenu: entree.contenu || null,
        urgence: entree.urgence || 'normale',
        destinataire: destinataire ? destinataire.nom : (entree.destinataire || null),
      });
      contexte.denouement = 'message';
      return {
        resultat:
          'Message enregistre et achemine' +
          (destinataire ? ` a ${destinataire.nom} (${destinataire.courriel || 'courriel non configure'})` : " a l'equipe") +
          '. Confirmer a l\'appelant que le message est pris et indiquer le delai de rappel habituel.',
      };
    }

    case 'transferer_appel': {
      if (!horaire.estOuvert(client)) {
        return {
          resultat:
            "Transfert impossible : l'entreprise est fermee en ce moment. Proposer de prendre " +
            'un message a la place, ou une urgence si la situation le justifie.',
        };
      }
      const membre = trouverMembre(client, entree.destinataire);
      const numero = membre?.telephone || client.numero_transfert_defaut;
      if (!numero) {
        return {
          resultat:
            'Aucun numero de transfert configure pour ce destinataire. Prendre un message a la place.',
        };
      }
      contexte.denouement = 'transfert';
      return {
        resultat: `Transfert en cours vers ${membre ? membre.nom : 'la reception'}.`,
        action: {
          type: 'transfert',
          numero,
          vers: membre ? membre.nom : 'reception',
          raison: entree.raison,
        },
      };
    }

    case 'verifier_disponibilites': {
      const occupes = store.rdvDuJour(client.id, entree.date);
      const libres = horaire.disponibilites(client, entree.date, occupes);
      if (!libres.length) {
        return {
          resultat: `Aucune plage libre le ${entree.date}. Proposer une autre date a l'appelant.`,
        };
      }
      return {
        resultat:
          `Plages libres le ${entree.date} : ${libres.join(', ')}. ` +
          "Proposer au plus deux ou trois choix a l'oral, pas la liste complete.",
      };
    }

    case 'prendre_rendez_vous': {
      const occupes = store.rdvDuJour(client.id, entree.date);
      const libres = horaire.disponibilites(client, entree.date, occupes);
      if (!libres.includes(entree.heure)) {
        return {
          resultat:
            `La plage ${entree.heure} n'est pas disponible le ${entree.date}. ` +
            `Plages libres : ${libres.join(', ') || 'aucune'}. Proposer autre chose.`,
        };
      }
      store.ajouterRdv({
        appel_id: appelId,
        client_id: client.id,
        nom: entree.nom,
        telephone: entree.telephone,
        courriel: entree.courriel || null,
        debut: `${entree.date}T${entree.heure}:00`,
        duree_min: client.rdv.duree_min || 30,
        objet: entree.objet,
      });
      contexte.denouement = 'rendez_vous';
      return {
        resultat:
          `Rendez-vous confirme le ${entree.date} a ${entree.heure}. ` +
          'Confirmer a l\'appelant et mentionner qu\'une confirmation suivra par texto.',
        action: { type: 'sms_confirmation', numero: entree.telephone, rdv: entree },
      };
    }

    case 'escalader_urgence': {
      store.ajouterMessage({
        appel_id: appelId,
        client_id: client.id,
        nom: 'Appel urgent',
        telephone: entree.rappel || null,
        objet: `URGENCE — ${entree.nature}`,
        contenu: `${entree.nature}${entree.lieu ? ` — lieu : ${entree.lieu}` : ''}`,
        urgence: 'urgente',
        destinataire: 'ligne urgence',
      });
      contexte.denouement = 'urgence';
      return {
        resultat: "Urgence enregistree. Transfert vers la ligne d'urgence en cours.",
        action: {
          type: 'transfert',
          numero: client.urgences.numero,
          vers: 'ligne urgence',
          raison: entree.nature,
        },
      };
    }

    case 'terminer_appel':
      contexte.categorie = entree.categorie;
      contexte.resume = entree.resume;
      if (entree.categorie === 'sollicitation') contexte.denouement = 'filtre';
      else if (!contexte.denouement) contexte.denouement = 'raccroche';
      return {
        resultat: 'Appel termine.',
        action: { type: 'raccrocher' },
      };

    default:
      return { resultat: `Outil inconnu : ${nom}` };
  }
}

function trouverMembre(client, recherche) {
  if (!recherche) return null;
  const r = recherche.toLowerCase().trim();
  if (r === 'reception' || r === 'réception') return null;
  return (
    client.equipe.find((m) => m.nom.toLowerCase() === r) ||
    client.equipe.find((m) => m.nom.toLowerCase().includes(r) || r.includes(m.nom.toLowerCase().split(' ')[0])) ||
    client.equipe.find((m) => (m.mots_cles || []).some((k) => r.includes(k))) ||
    null
  );
}

const REPONSE_FAQ_VIDE =
  "Aucune reponse dans la FAQ pour cette question. Ne pas inventer de reponse : " +
  "dire a l'appelant que la question sera acheminee a l'equipe, et prendre un message.";

// Mots trop courants pour porter du sens : sans ce filtre, « vous » suffisait
// a faire correspondre n'importe quelle question a n'importe quelle entree.
const MOTS_VIDES = new Set([
  'vous', 'nous', 'pour', 'avec', 'dans', 'chez', 'mais', 'donc', 'est', 'sont',
  'etes', 'suis', 'cette', 'cela', 'quel', 'quelle', 'quels', 'quelles', 'comment',
  'pourquoi', 'quand', 'aussi', 'plus', 'moins', 'tres', 'bien', 'faire', 'fait',
  'avez', 'avoir', 'etre', 'votre', 'notre', 'leur', 'mon', 'son', 'des', 'les',
  'une', 'que', 'qui', 'quoi', 'ceci', 'tout', 'tous', 'toute', 'toutes',
  'peut', 'peux', 'pouvez', 'dire', 'savoir', 'ceux', 'celle', 'sur', 'par',
  'ils', 'elle', 'elles', 'bonjour', 'merci', 'oui', 'non', 'juste', 'genre',
]);

/** Minuscules sans accents : « accrédités » et « accredites » doivent concorder. */
function normaliser(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function motsSignifiants(texte) {
  return [...new Set(
    normaliser(texte)
      .split(/\W+/)
      .filter((m) => m.length > 3 && !MOTS_VIDES.has(m))
  )];
}

function consulterInfos(client, entree) {
  switch (entree.sujet) {
    case 'heures':
      return `Heures d'ouverture : ${horaire.heuresLisibles(client)}. ` +
        (horaire.estOuvert(client) ? "L'entreprise est ouverte en ce moment." : "L'entreprise est fermee en ce moment.");

    case 'adresse':
      return client.adresse || 'Adresse non renseignee dans la fiche.';

    case 'coordonnees':
      return [
        client.telephone_public ? `Telephone : ${client.telephone_public}` : null,
        client.courriel_public ? `Courriel : ${client.courriel_public}` : null,
        client.site_web ? `Site web : ${client.site_web}` : null,
        client.adresse ? `Adresse : ${client.adresse}` : null,
      ].filter(Boolean).join(' — ') || 'Coordonnees non renseignees.';

    case 'services':
      return client.services.length
        ? `Services offerts : ${client.services.map((s) => (typeof s === 'string' ? s : `${s.nom}${s.description ? ` (${s.description})` : ''}`)).join(' ; ')}`
        : 'Aucun service listee dans la fiche.';

    case 'faq': {
      const mots = motsSignifiants(entree.question || '');
      if (!mots.length) return REPONSE_FAQ_VIDE;

      const notes = client.faq.map((f) => {
        const texte = normaliser(`${f.q} ${f.r}`);
        const trouves = mots.filter((m) => texte.includes(m));
        // Un seul mot en commun ne suffit pas quand la question en compte
        // plusieurs : c'est ainsi qu'une question hors sujet recevait une
        // reponse sans rapport.
        return { f, note: trouves.length / mots.length };
      });
      notes.sort((a, b) => b.note - a.note);

      const seuil = mots.length === 1 ? 1 : 0.4;
      const retenues = notes.filter((n) => n.note >= seuil).slice(0, 2);
      if (!retenues.length) return REPONSE_FAQ_VIDE;

      return retenues.map((n) => `Q : ${n.f.q}\nR : ${n.f.r}`).join('\n\n');
    }

    default:
      return 'Sujet inconnu.';
  }
}

module.exports = { definitions, executer, trouverMembre };
