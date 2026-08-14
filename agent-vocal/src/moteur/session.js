const crypto = require('crypto');
const { store } = require('../db');
const { Ecoute } = require('./stt');
const { Voix } = require('./tts');
const { Cerveau } = require('./cerveau');

/**
 * Orchestre un appel : audio telephonique -> reconnaissance -> Claude -> synthese
 * -> audio telephonique, plus les actions (transfert, raccrochage, texto).
 *
 * La session est agnostique du fournisseur telephonique : elle reçoit un objet
 * `ligne` qui sait pousser de l'audio, vider la file, marquer et raccrocher.
 */
class SessionAppel {
  constructor({ client, ligne, appelant, numeroAppele }) {
    this.client = client;
    this.ligne = ligne;
    this.appelant = appelant;
    this.id = `apl_${crypto.randomBytes(8).toString('hex')}`;
    this.debut = Date.now();
    this.transcription = [];
    this.agentParle = false;
    this.generationCourante = 0;
    this.terminee = false;
    this.enTraitement = false;
    this.filesDeParole = [];

    this.contexte = {
      client,
      appelId: this.id,
      appelant,
      denouement: null,
      categorie: null,
      resume: null,
    };

    store.ouvrirAppel({
      id: this.id,
      client_id: client.id,
      appelant: appelant || null,
      numero_appele: numeroAppele || null,
    });

    this.cerveau = new Cerveau(client, this.contexte);
    this.ecoute = new Ecoute({ langue: client.langue }).connecter();
    this.voix = new Voix({
      voixId: client.voix_id,
      reglages: client.voix_reglages,
    }).connecter();

    this.brancher();
  }

  brancher() {
    // ── Audio synthetise -> ligne telephonique ──────────────────────────────
    this.voix.on('audio', (paquet, generation) => {
      if (this.terminee) return;
      if (generation !== this.generationCourante) return; // reste d'un tour interrompu
      this.agentParle = true;
      this.ligne.pousserAudio(paquet);
    });

    this.voix.on('erreur', (e) => this.surErreur('tts', e));

    // ── Barge-in : l'appelant coupe l'agent ─────────────────────────────────
    this.ecoute.on('parole', () => {
      if (!this.agentParle) return;
      this.generationCourante = this.voix.interrompre();
      this.ligne.viderAudio();
      this.agentParle = false;
      store.journaliser(this.id, this.client.id, 'barge_in', null);
    });

    // ── Tour de parole complet de l'appelant ────────────────────────────────
    this.ecoute.on('final', (texte) => {
      this.transcription.push({ qui: 'appelant', texte, t: Date.now() - this.debut });
      this.filesDeParole.push(texte);
      this.viderFileDeParole();
    });

    this.ecoute.on('erreur', (e) => this.surErreur('stt', e));
  }

  /** Lance l'accueil des que la ligne est prete. */
  async demarrer() {
    try {
      const { actions } = await this.cerveau.ouvrir((phrase) => this.direPhrase(phrase));
      await this.appliquerActions(actions);
    } catch (e) {
      this.surErreur('llm', e);
    }
  }

  /**
   * Traite les tours de parole un a la fois. Si l'appelant parle pendant que
   * l'agent reflechit, la phrase est mise en file plutot que perdue.
   */
  async viderFileDeParole() {
    if (this.enTraitement || this.terminee) return;
    const texte = this.filesDeParole.shift();
    if (!texte) return;

    this.enTraitement = true;
    try {
      // Regrouper ce qui a pu s'accumuler pendant l'attente.
      const groupe = [texte, ...this.filesDeParole.splice(0)].join(' ');
      const { actions } = await this.cerveau.repondre(groupe, (phrase) => this.direPhrase(phrase));
      await this.appliquerActions(actions);
    } catch (e) {
      this.surErreur('llm', e);
    } finally {
      this.enTraitement = false;
      if (this.filesDeParole.length) this.viderFileDeParole();
    }
  }

  direPhrase(phrase) {
    if (this.terminee) return;
    this.transcription.push({ qui: 'agent', texte: phrase, t: Date.now() - this.debut });
    this.voix.dire(phrase);
  }

  async appliquerActions(actions) {
    for (const action of actions) {
      switch (action.type) {
        case 'transfert':
          store.journaliser(this.id, this.client.id, 'transfert', action);
          // Laisser l'annonce se terminer avant de basculer l'appel.
          await this.ligne.attendreFinAudio(6000);
          await this.ligne.transferer(action.numero);
          this.fermer('transfert');
          break;

        case 'raccrocher':
          await this.ligne.attendreFinAudio(8000);
          await this.ligne.raccrocher();
          this.fermer(this.contexte.denouement || 'raccroche');
          break;

        case 'sms_confirmation':
          store.journaliser(this.id, this.client.id, 'sms_confirmation', action);
          if (this.ligne.envoyerSms && this.client.sms_suivi !== false) {
            const r = action.rdv;
            this.ligne
              .envoyerSms(
                action.numero,
                `${this.client.nom} — rendez-vous confirme le ${r.date} a ${r.heure}. ` +
                  `Objet : ${r.objet}. Pour modifier, appelez-nous.`
              )
              .catch((e) => console.error(`[AVIS] Texto non envoye : ${e.message}`));
          }
          break;

        default:
          break;
      }
    }
  }

  surErreur(source, e) {
    console.error(`[ERREUR] Appel ${this.id} — ${source} : ${e.message}`);
    store.journaliser(this.id, this.client.id, `erreur_${source}`, e.message);
    if (this.terminee) return;

    // Une panne du moteur ne doit jamais laisser l'appelant sur une ligne muette.
    const repli = this.client.numero_transfert_defaut;
    if (repli && this.ligne.transferer) {
      this.ligne.transferer(repli).catch(() => this.ligne.raccrocher());
      this.fermer('erreur_transfert');
    } else {
      this.ligne.raccrocher().catch(() => {});
      this.fermer('erreur');
    }
  }

  fermer(denouement) {
    if (this.terminee) return;
    this.terminee = true;

    this.ecoute.fermer();
    this.voix.fermer();

    store.fermerAppel(this.id, {
      duree_s: Math.round((Date.now() - this.debut) / 1000),
      denouement: denouement || this.contexte.denouement || 'raccroche',
      categorie: this.contexte.categorie,
      resume: this.contexte.resume,
      transcription: JSON.stringify(this.transcription),
    });

    console.log(
      `[INFO] Appel ${this.id} (${this.client.id}) termine — ` +
        `${Math.round((Date.now() - this.debut) / 1000)} s, denouement : ${denouement}`
    );
  }
}

module.exports = { SessionAppel };
