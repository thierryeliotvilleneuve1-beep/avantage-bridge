const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { config } = require('../config');

/**
 * Reconnaissance vocale en continu (Deepgram), branchee directement sur le flux
 * mu-law 8 kHz de la telephonie — aucune conversion audio n'est necessaire.
 *
 * Evenements :
 *   'parole'      — l'appelant vient de commencer a parler (sert au barge-in)
 *   'partiel'     — transcription provisoire (string)
 *   'final'       — tour de parole termine (string)
 *   'erreur'      — Error
 *   'ferme'       — la connexion est close
 */
class Ecoute extends EventEmitter {
  constructor(options = {}) {
    super();
    this.langue = options.langue || config.stt.langue;
    this.modele = options.modele || config.stt.modele;
    this.pret = false;
    this.filesAttente = [];
    this.accumule = '';
    this.fermeVolontairement = false;
  }

  connecter() {
    const params = new URLSearchParams({
      model: this.modele,
      language: this.langue,
      encoding: 'mulaw',
      sample_rate: '8000',
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      // Fin de tour de parole apres 500 ms de silence : compromis entre
      // reactivite et interruption prematuree d'un appelant qui hesite.
      endpointing: '500',
      utterance_end_ms: '1000',
      vad_events: 'true',
      filler_words: 'false',
    });

    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${config.stt.cle}` },
    });

    this.ws.on('open', () => {
      this.pret = true;
      for (const paquet of this.filesAttente) this.ws.send(paquet);
      this.filesAttente = [];
      // Maintien de connexion : Deepgram ferme apres 10 s sans trafic.
      this.pouls = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 5000);
    });

    this.ws.on('message', (brut) => {
      let msg;
      try {
        msg = JSON.parse(brut.toString());
      } catch {
        return;
      }

      if (msg.type === 'SpeechStarted') {
        this.emit('parole');
        return;
      }

      if (msg.type === 'UtteranceEnd') {
        this.livrer();
        return;
      }

      if (msg.type !== 'Results') return;
      const texte = msg.channel?.alternatives?.[0]?.transcript?.trim();
      if (!texte) return;

      if (msg.is_final) {
        this.accumule = `${this.accumule} ${texte}`.trim();
        if (msg.speech_final) this.livrer();
      } else {
        this.emit('partiel', texte);
      }
    });

    this.ws.on('error', (e) => this.emit('erreur', e));
    this.ws.on('close', () => {
      clearInterval(this.pouls);
      this.pret = false;
      if (!this.fermeVolontairement) this.emit('erreur', new Error('Connexion Deepgram fermee'));
      this.emit('ferme');
    });

    return this;
  }

  livrer() {
    const texte = this.accumule.trim();
    this.accumule = '';
    if (texte) this.emit('final', texte);
  }

  /** @param {Buffer} audio  echantillons mu-law 8 kHz */
  envoyer(audio) {
    if (this.pret && this.ws.readyState === WebSocket.OPEN) this.ws.send(audio);
    else if (this.filesAttente.length < 200) this.filesAttente.push(audio);
  }

  fermer() {
    this.fermeVolontairement = true;
    clearInterval(this.pouls);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch { /* la connexion se ferme de toute façon */ }
      this.ws.close();
    }
  }
}

module.exports = { Ecoute };
