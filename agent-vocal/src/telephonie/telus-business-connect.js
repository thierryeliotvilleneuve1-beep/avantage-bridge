const { config } = require('../config');

/**
 * Telus Business Connect est RingCentral en marque blanche : l'API est la meme.
 *
 * Le module ne porte PAS l'audio de l'appel — Telus Business Connect ne donne pas
 * acces au flux media brut sur les forfaits PME. Le branchement se fait par renvoi
 * d'appel vers le numero Twilio de l'agent (voir README, section « Branchement »).
 *
 * Ce module sert a trois choses :
 *   1. envoyer les textos de suivi depuis le vrai numero de l'entreprise ;
 *   2. lire le journal d'appels pour reconcilier ce que l'agent a traite ;
 *   3. poser et retirer la regle de renvoi, sans passer par l'interface web.
 */

let jeton = null;
let expire = 0;

async function authentifier() {
  if (jeton && Date.now() < expire - 60000) return jeton;
  if (!config.tbc.actif) throw new Error('Telus Business Connect non configure');

  const cle = Buffer.from(`${config.tbc.clientId}:${config.tbc.clientSecret}`).toString('base64');
  const r = await fetch(`${config.tbc.serveur}/restapi/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${cle}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: config.tbc.jwt,
    }),
  });
  if (!r.ok) throw new Error(`Authentification TBC ${r.status} : ${(await r.text()).slice(0, 300)}`);

  const d = await r.json();
  jeton = d.access_token;
  expire = Date.now() + d.expires_in * 1000;
  return jeton;
}

async function appeler(methode, chemin, corps) {
  const t = await authentifier();
  const r = await fetch(`${config.tbc.serveur}${chemin}`, {
    method: methode,
    headers: {
      Authorization: `Bearer ${t}`,
      ...(corps ? { 'Content-Type': 'application/json' } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  if (!r.ok) throw new Error(`TBC ${methode} ${chemin} — ${r.status} : ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
}

const tbc = {
  disponible: () => config.tbc.actif,

  /** Envoie un texto depuis le numero principal de l'entreprise. */
  async envoyerSms(destinataire, texte) {
    if (!config.tbc.numeroSms) throw new Error('TBC_NUMERO_SMS non configure');
    return appeler('POST', '/restapi/v1.0/account/~/extension/~/sms', {
      from: { phoneNumber: config.tbc.numeroSms },
      to: [{ phoneNumber: destinataire }],
      text: texte,
    });
  },

  /** Journal des appels recus, pour reconciliation avec la base de l'agent. */
  async journalAppels({ depuis, jusqua, parPage = 100 } = {}) {
    const p = new URLSearchParams({ perPage: String(parPage), view: 'Detailed' });
    if (depuis) p.set('dateFrom', depuis);
    if (jusqua) p.set('dateTo', jusqua);
    const d = await appeler('GET', `/restapi/v1.0/account/~/call-log?${p}`);
    return (d.records || []).map((a) => ({
      id: a.id,
      debut: a.startTime,
      duree_s: a.duration,
      direction: a.direction,
      de: a.from?.phoneNumber,
      vers: a.to?.phoneNumber,
      resultat: a.result,
    }));
  },

  /** Liste les regles de reponse de l'extension, pour reperer le renvoi actif. */
  async reglesReponse() {
    const d = await appeler('GET', '/restapi/v1.0/account/~/extension/~/answering-rule');
    return (d.records || []).map((r) => ({
      id: r.id,
      nom: r.name,
      active: r.enabled,
      type: r.type,
      action: r.callHandlingAction,
      renvoi: (r.forwarding?.rules || []).map((x) => x.forwardingNumberId || x.phoneNumber),
    }));
  },

  /**
   * Cree la regle qui envoie les appels vers l'agent vocal.
   * @param {string} numeroAgent  numero Twilio de l'agent, format E.164
   * @param {object} options  { nom, horaire, toujours }
   */
  async creerRenvoiVersAgent(numeroAgent, options = {}) {
    const regle = {
      name: options.nom || 'Agent vocal Standard 24',
      enabled: true,
      type: options.toujours ? 'Custom' : 'BusinessHours',
      callHandlingAction: 'ForwardCalls',
      forwarding: {
        notifyMySoftPhones: false,
        notifyAdminSoftPhones: false,
        softPhonesRingCount: 1,
        ringingMode: 'Sequentially',
        rules: [
          {
            index: 1,
            ringCount: 4,
            enabled: true,
            forwardingNumbers: [{ phoneNumber: numeroAgent, label: 'Standard 24', type: 'Other' }],
          },
        ],
      },
    };
    if (options.horaire) regle.schedule = options.horaire;
    return appeler('POST', '/restapi/v1.0/account/~/extension/~/answering-rule', regle);
  },

  async supprimerRegle(id) {
    return appeler('DELETE', `/restapi/v1.0/account/~/extension/~/answering-rule/${id}`);
  },
};

module.exports = { tbc };
