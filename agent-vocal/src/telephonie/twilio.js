const crypto = require('crypto');
const { config } = require('../config');

const BASE = 'https://api.twilio.com/2010-04-01';

function entete() {
  const jeton = Buffer.from(`${config.twilio.sid}:${config.twilio.token}`).toString('base64');
  return { Authorization: `Basic ${jeton}` };
}

async function appelerApi(chemin, corps) {
  const r = await fetch(`${BASE}/Accounts/${config.twilio.sid}${chemin}`, {
    method: 'POST',
    headers: { ...entete(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(corps),
  });
  if (!r.ok) {
    throw new Error(`Twilio ${r.status} : ${(await r.text()).slice(0, 300)}`);
  }
  return r.json();
}

function echapperXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])
  );
}

/**
 * TwiML servi a l'arrivee d'un appel : ouvre un flux audio bidirectionnel
 * vers notre WebSocket.
 */
function twimlAccueil(urlWebsocket, parametres = {}) {
  const params = Object.entries(parametres)
    .map(([k, v]) => `<Parameter name="${echapperXml(k)}" value="${echapperXml(v ?? '')}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${echapperXml(urlWebsocket)}">${params}</Stream>
  </Connect>
</Response>`;
}

/**
 * Une ligne telephonique Twilio vue par le moteur vocal.
 * Encapsule le WebSocket Media Streams et l'API REST.
 */
class LigneTwilio {
  constructor(ws, { callSid, streamSid }) {
    this.ws = ws;
    this.callSid = callSid;
    this.streamSid = streamSid;
    this.marques = new Map();
  }

  /** @param {Buffer} audio  mu-law 8 kHz */
  pousserAudio(audio) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(
      JSON.stringify({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: audio.toString('base64') },
      })
    );
  }

  /** Jette tout l'audio deja envoye mais pas encore joue (barge-in). */
  viderAudio() {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    for (const [, resoudre] of this.marques) resoudre();
    this.marques.clear();
  }

  /**
   * Attend que tout l'audio en file soit reellement joue. Twilio renvoie
   * l'evenement « mark » quand la lecture atteint le repere.
   */
  attendreFinAudio(delaiMax = 8000) {
    if (this.ws.readyState !== this.ws.OPEN) return Promise.resolve();
    const nom = `m_${crypto.randomBytes(4).toString('hex')}`;
    return new Promise((resoudre) => {
      const minuteur = setTimeout(() => {
        this.marques.delete(nom);
        resoudre();
      }, delaiMax);
      this.marques.set(nom, () => {
        clearTimeout(minuteur);
        this.marques.delete(nom);
        resoudre();
      });
      this.ws.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name: nom } }));
    });
  }

  /** Appele par le serveur quand Twilio confirme un repere. */
  confirmerMarque(nom) {
    const resoudre = this.marques.get(nom);
    if (resoudre) resoudre();
  }

  async transferer(numero) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Dial timeout="25" callerId="${echapperXml(config.twilio.numero)}">${echapperXml(numero)}</Dial></Response>`;
    await appelerApi(`/Calls/${this.callSid}.json`, { Twiml: twiml });
  }

  async raccrocher() {
    try {
      await appelerApi(`/Calls/${this.callSid}.json`, { Status: 'completed' });
    } catch (e) {
      // L'appelant a peut-etre deja raccroche : ce n'est pas une erreur.
      if (!/20404|not found/i.test(e.message)) throw e;
    }
  }

  async envoyerSms(destinataire, texte) {
    if (!config.twilio.numero) throw new Error('TWILIO_NUMERO non configure');
    await appelerApi('/Messages.json', {
      From: config.twilio.numero,
      To: destinataire,
      Body: texte,
    });
  }
}

let signatureIgnoreeSignalee = false;

/**
 * Verifie la signature Twilio d'une requete entrante.
 * Sans jeton configure la verification est impossible : la requete passe, mais
 * l'endpoint est alors ouvert a n'importe qui. On le signale une fois plutot que
 * de laisser le trou passer inaperçu.
 */
function signatureValide(url, parametres, signature) {
  if (!config.twilio.token) {
    if (!signatureIgnoreeSignalee) {
      signatureIgnoreeSignalee = true;
      console.warn(
        '[ALERTE] TWILIO_AUTH_TOKEN absent : les signatures ne sont pas vérifiées. ' +
          "L'endpoint /twilio/voix accepte n'importe quelle requête. À corriger avant la mise en service."
      );
    }
    return true;
  }
  const donnees = Object.keys(parametres)
    .sort()
    .reduce((acc, k) => acc + k + parametres[k], url);
  const attendue = crypto
    .createHmac('sha1', config.twilio.token)
    .update(Buffer.from(donnees, 'utf-8'))
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(attendue), Buffer.from(signature || ''));
  } catch {
    return false;
  }
}

module.exports = { LigneTwilio, twimlAccueil, signatureValide, echapperXml, appelerApi };
