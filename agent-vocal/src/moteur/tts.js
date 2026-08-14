const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { config } = require('../config');

/**
 * Synthese vocale en continu (ElevenLabs), en sortie mu-law 8 kHz —
 * le format que la telephonie attend, sans reechantillonnage.
 *
 * Evenements :
 *   'audio'  — Buffer mu-law 8 kHz pret a etre pousse sur la ligne
 *   'fini'   — la phrase en cours a fini d'etre synthetisee
 *   'erreur' — Error
 */
class Voix extends EventEmitter {
  constructor(options = {}) {
    super();
    this.voixId = options.voixId || config.tts.voixDefaut;
    this.modele = options.modele || config.tts.modele;
    this.reglages = options.reglages || { stability: 0.45, similarity_boost: 0.8, speed: 1.0 };
    this.pret = false;
    this.filesAttente = [];
    this.fermeVolontairement = false;
    this.generation = 0;
  }

  connecter() {
    if (!this.voixId) {
      this.emit('erreur', new Error('Aucune voix configuree (VOIX_DEFAUT ou client.voix_id)'));
      return this;
    }

    const params = new URLSearchParams({
      model_id: this.modele,
      output_format: 'ulaw_8000',
      language_code: 'fr',
      // Declenche la synthese des qu'un debut de phrase est disponible.
      auto_mode: 'true',
      inactivity_timeout: '180',
    });

    this.ws = new WebSocket(
      `wss://api.elevenlabs.io/v1/text-to-speech/${this.voixId}/stream-input?${params}`,
      { headers: { 'xi-api-key': config.tts.cle } }
    );

    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({
        text: ' ',
        voice_settings: this.reglages,
      }));
      this.pret = true;
      for (const t of this.filesAttente) this.dire(t);
      this.filesAttente = [];
    });

    this.ws.on('message', (brut) => {
      let msg;
      try {
        msg = JSON.parse(brut.toString());
      } catch {
        return;
      }
      if (msg.audio) {
        this.emit('audio', Buffer.from(msg.audio, 'base64'), this.generation);
      }
      if (msg.isFinal) this.emit('fini', this.generation);
      if (msg.error) this.emit('erreur', new Error(msg.error));
    });

    this.ws.on('error', (e) => this.emit('erreur', e));
    this.ws.on('close', () => {
      this.pret = false;
      if (!this.fermeVolontairement) this.emit('erreur', new Error('Connexion ElevenLabs fermee'));
    });

    return this;
  }

  /** Ajoute du texte a synthetiser. */
  dire(texte) {
    const propre = nettoyerPourLaVoix(texte);
    if (!propre) return;
    if (!this.pret) {
      this.filesAttente.push(propre);
      return;
    }
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ text: `${propre} `, flush: true }));
  }

  /**
   * Abandonne tout l'audio en cours de synthese (barge-in). Les paquets d'une
   * generation anterieure sont ignores par la session grace au compteur.
   */
  interrompre() {
    this.generation += 1;
    this.filesAttente = [];
    if (this.pret && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ text: '', flush: true }));
      } catch { /* rien a faire */ }
    }
    return this.generation;
  }

  fermer() {
    this.fermeVolontairement = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ text: '' }));
      } catch { /* rien a faire */ }
      this.ws.close();
    }
  }
}

/**
 * Retire ce qui ne se prononce pas et corrige ce qui se prononce mal.
 * Filet de securite : le prompt demande deja a l'agent de ne pas produire de balisage.
 */
function nettoyerPourLaVoix(texte) {
  return String(texte)
    .replace(/[*_`#]/g, '')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .replace(/\bM\./g, 'Monsieur')
    .replace(/\bMme\b/g, 'Madame')
    .replace(/\bh\b/g, 'heures')
    .trim();
}

module.exports = { Voix, nettoyerPourLaVoix };
