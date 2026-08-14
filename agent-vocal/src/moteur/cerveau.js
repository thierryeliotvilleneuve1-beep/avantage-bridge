const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');
const horaire = require('../horaire');
const outils = require('./outils');

const client = new Anthropic({ apiKey: config.llm.cle });

const BETA_FALLBACK = 'server-side-fallback-2026-07-01';

/** Construit le prompt systeme a partir de la fiche du client. */
function promptSysteme(c, contexteAppel) {
  const p = c.persona;
  const ouvert = horaire.estOuvert(c);
  const maintenant = horaire.momentLisible(new Date(), c.fuseau);

  const equipe = c.equipe.length
    ? c.equipe
        .map((m) => `- ${m.nom}, ${m.role}${m.mots_cles?.length ? ` — a joindre pour : ${m.mots_cles.join(', ')}` : ''}`)
        .join('\n')
    : '- Aucun membre configure. Prendre les messages pour la reception.';

  return `Tu es ${p.nom_agent}, receptionniste de ${c.nom}${c.secteur ? `, une entreprise du secteur ${c.secteur}` : ''} au Quebec. Tu reponds au telephone.

# Contexte de l'appel
Nous sommes ${maintenant} (heure locale). L'entreprise est actuellement ${ouvert ? 'OUVERTE' : 'FERMEE'}.
Heures d'ouverture : ${horaire.heuresLisibles(c)}.
${contexteAppel.appelant ? `Le numero affiche de l'appelant est ${contexteAppel.appelant}.` : "Le numero de l'appelant n'est pas affiche."}

# L'equipe
${equipe}

# Comment tu parles
Tu parles au telephone : ce que tu ecris est lu a voix haute, tel quel.
- Français quebecois naturel, vouvoiement, ton ${p.ton || 'chaleureux et professionnel'}.
- Une ou deux phrases par tour. Jamais de paragraphe.
- Aucune mise en forme : pas de puces, pas de tirets, pas d'asterisques, pas d'emoji.
- Les nombres s'ecrivent comme on les dit : « quatre cent dix-huit, trois six cinq, sept neuf sept trois » pour un numero de telephone, « quatorze heures trente » pour une heure.
- Pose une seule question a la fois, puis attends la reponse.
- Si tu n'as pas compris, demande de repeter plutot que de deviner.
- L'appelant peut te couper la parole : quand ça arrive, arrete-toi et ecoute.

# Ce que tu fais
1. Tu accueilles, tu identifies le besoin, tu agis.
2. Tu utilises tes outils pour toute information sur l'entreprise. Tu ne dis jamais un prix, une date, une disponibilite ou une politique que tes outils ne t'ont pas donne.
3. Si tu ne sais pas, tu le dis et tu prends un message. C'est une bonne reponse.
4. Tu ne promets rien au nom de l'entreprise : ni delai, ni prix, ni engagement.
5. Avant de raccrocher, tu resumes ce qui a ete fait et tu salues.

# Regles particulieres
${ouvert
  ? '- Tu peux transferer un appel en direct vers un membre de l\'equipe.'
  : "- L'entreprise est fermee : aucun transfert possible. Tu prends les messages."}
${c.urgences?.numero
  ? `- Urgences : si l'appel concerne ${(c.urgences.mots_cles || []).join(', ')}, tu escalades immediatement, meme la nuit.`
  : ''}
${c.exclusions?.length
  ? `- Sollicitation commerciale (${c.exclusions.join(', ')}) : tu remercies poliment, tu indiques que l'entreprise ne prend pas ces appels, et tu termines. Tu ne prends pas de message et tu ne transferes pas.`
  : ''}
${c.rdv?.actif ? '- Tu peux fixer des rendez-vous, apres avoir verifie les disponibilites.' : ''}
${c.consignes ? `\n# Consignes propres a l'entreprise\n${c.consignes}` : ''}

# Ta premiere phrase
« ${p.presentation || `${c.nom}, bonjour, ${p.nom_agent} a l'appareil. Comment puis-je vous aider ?`} »`;
}

class Cerveau {
  constructor(clientPme, contexteAppel) {
    this.client = clientPme;
    this.contexte = contexteAppel;
    this.systeme = promptSysteme(clientPme, contexteAppel);
    this.outils = outils.definitions(clientPme);
    this.historique = [];
    this.utiliserFallback = config.llm.fallback;
  }

  /**
   * Traite un tour de parole et diffuse la reponse phrase par phrase.
   * @param {string} texteAppelant
   * @param {(phrase: string) => void} surPhrase  appele des qu'une phrase est prete a etre dite
   * @returns {Promise<{texte: string, actions: object[]}>}
   */
  async repondre(texteAppelant, surPhrase) {
    this.historique.push({ role: 'user', content: texteAppelant });
    return this.boucle(surPhrase);
  }

  /** Fait parler l'agent en premier, sans entree de l'appelant. */
  async ouvrir(surPhrase) {
    this.historique.push({
      role: 'user',
      content: "[Le telephone vient de sonner et la ligne est ouverte. Accueille l'appelant.]",
    });
    return this.boucle(surPhrase);
  }

  async boucle(surPhrase) {
    const actions = [];
    let texteComplet = '';

    for (let tour = 0; tour < 6; tour += 1) {
      const reponse = await this.appelerModele(surPhrase);

      const texte = reponse.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      texteComplet += texte;

      if (reponse.stop_reason === 'refusal') {
        const repli = "Je m'excuse, je ne peux pas traiter cette demande. Je vais prendre un message pour l'equipe.";
        surPhrase(repli);
        texteComplet += repli;
        this.historique.push({ role: 'assistant', content: repli });
        break;
      }

      // Ne conserver que les blocs que l'API accepte en rejeu.
      this.historique.push({
        role: 'assistant',
        content: reponse.content.filter((b) => b.type === 'text' || b.type === 'tool_use' || b.type === 'thinking'),
      });

      const appelsOutils = reponse.content.filter((b) => b.type === 'tool_use');
      if (!appelsOutils.length) break;

      const resultats = [];
      for (const appel of appelsOutils) {
        let sortie;
        try {
          sortie = outils.executer(appel.name, appel.input || {}, this.contexte);
        } catch (e) {
          console.error(`[ERREUR] Outil ${appel.name} : ${e.message}`);
          sortie = { resultat: `Erreur technique lors de l'execution : ${e.message}` };
        }
        if (sortie.action) actions.push(sortie.action);
        resultats.push({
          type: 'tool_result',
          tool_use_id: appel.id,
          content: sortie.resultat,
        });
      }
      this.historique.push({ role: 'user', content: resultats });

      // Une action terminale coupe court : inutile de relancer le modele.
      if (actions.some((a) => a.type === 'raccrocher' || a.type === 'transfert')) break;
    }

    return { texte: texteComplet, actions };
  }

  async appelerModele(surPhrase) {
    const parametres = {
      model: config.llm.modele,
      max_tokens: 2048,
      system: [{ type: 'text', text: this.systeme, cache_control: { type: 'ephemeral' } }],
      tools: this.outils,
      messages: this.historique,
      thinking: { type: 'adaptive' },
      output_config: { effort: config.llm.effort },
    };

    const tampon = new TamponPhrases(surPhrase);

    try {
      const flux = this.utiliserFallback
        ? client.beta.messages.stream({
            ...parametres,
            betas: [BETA_FALLBACK],
            fallbacks: 'default',
          })
        : client.messages.stream(parametres);

      flux.on('text', (delta) => tampon.pousser(delta));
      const message = await flux.finalMessage();
      tampon.vider();
      return message;
    } catch (e) {
      // Le repli serveur est une beta : si le compte n'y a pas acces, on continue sans.
      if (this.utiliserFallback && e instanceof Anthropic.BadRequestError) {
        console.warn('[AVIS] Repli serveur indisponible, poursuite sans « fallbacks ».');
        this.utiliserFallback = false;
        return this.appelerModele(surPhrase);
      }
      throw e;
    }
  }
}

/**
 * Decoupe le flux de texte en phrases completes pour alimenter la synthese vocale
 * sans attendre la fin de la generation.
 */
class TamponPhrases {
  constructor(surPhrase) {
    this.surPhrase = surPhrase;
    this.tampon = '';
  }

  pousser(delta) {
    this.tampon += delta;
    // Fin de phrase suivie d'une espace, ou segment devenu assez long pour etre dit.
    let m;
    const fin = /([.!?…]+|,(?=\s))\s/g;
    let dernier = 0;
    while ((m = fin.exec(this.tampon)) !== null) {
      const coupe = m.index + m[0].length;
      const segment = this.tampon.slice(dernier, coupe).trim();
      if (segment.length >= 12) {
        this.surPhrase(segment);
        dernier = coupe;
      }
    }
    if (dernier > 0) this.tampon = this.tampon.slice(dernier);
  }

  vider() {
    const reste = this.tampon.trim();
    if (reste) this.surPhrase(reste);
    this.tampon = '';
  }
}

module.exports = { Cerveau, promptSysteme };
