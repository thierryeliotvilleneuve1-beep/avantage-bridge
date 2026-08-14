require('dotenv').config();
const path = require('path');

function requis(nom) {
  const v = process.env[nom];
  if (!v) throw new Error(`Variable d'environnement manquante : ${nom}`);
  return v;
}

const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  urlPublique: (process.env.URL_PUBLIQUE || '').replace(/\/+$/, ''),
  cleAdmin: process.env.CLE_ADMIN || 'CHANGE_MOI_CLE_LONGUE_ET_ALEATOIRE',

  racine: path.resolve(__dirname, '..'),
  dossierClients: path.resolve(__dirname, '../data/clients'),
  fichierDb: path.resolve(__dirname, '../data/standard24.db'),

  llm: {
    cle: process.env.ANTHROPIC_API_KEY || '',
    modele: process.env.MODELE_LLM || 'claude-opus-5',
    effort: process.env.EFFORT_LLM || 'low',
    fallback: process.env.FALLBACK_LLM !== 'false',
    maxTokens: 1024,
  },

  stt: {
    cle: process.env.DEEPGRAM_API_KEY || '',
    modele: process.env.MODELE_STT || 'nova-2',
    langue: process.env.LANGUE_STT || 'fr-CA',
  },

  tts: {
    cle: process.env.ELEVENLABS_API_KEY || '',
    voixDefaut: process.env.VOIX_DEFAUT || '',
    modele: process.env.MODELE_TTS || 'eleven_flash_v2_5',
  },

  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID || '',
    token: process.env.TWILIO_AUTH_TOKEN || '',
    numero: process.env.TWILIO_NUMERO || '',
  },

  tbc: {
    serveur: process.env.TBC_SERVER_URL || 'https://platform.ringcentral.com',
    clientId: process.env.TBC_CLIENT_ID || '',
    clientSecret: process.env.TBC_CLIENT_SECRET || '',
    jwt: process.env.TBC_JWT || '',
    numeroSms: process.env.TBC_NUMERO_SMS || '',
    get actif() {
      return Boolean(this.clientId && this.clientSecret && this.jwt);
    },
  },

  smtp: {
    hote: process.env.SMTP_HOTE || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    usager: process.env.SMTP_USAGER || '',
    motdepasse: process.env.SMTP_MOTDEPASSE || '',
    expediteur: process.env.SMTP_EXPEDITEUR || '',
    get actif() {
      return Boolean(this.hote && this.usager);
    },
  },
};

// Verifie les elements sans lesquels aucun appel ne peut aboutir.
config.verifier = function verifier() {
  const manquants = [];
  if (!config.llm.cle) manquants.push('ANTHROPIC_API_KEY');
  if (!config.stt.cle) manquants.push('DEEPGRAM_API_KEY');
  if (!config.tts.cle) manquants.push('ELEVENLABS_API_KEY');
  if (!config.urlPublique) manquants.push('URL_PUBLIQUE');
  return manquants;
};

module.exports = { config, requis };
