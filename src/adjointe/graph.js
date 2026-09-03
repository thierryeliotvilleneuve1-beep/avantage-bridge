// Client Microsoft Graph — accès applicatif restreint à la boîte projets@c-rc.ca
// L'étendue réelle est verrouillée côté Exchange par une ApplicationAccessPolicy
// (voir docs/ADJOINTE-IA.md §2). Le code ne doit jamais viser une autre boîte.
const https = require('https');
const { MAILBOX } = require('./config');

const TENANT = process.env.GRAPH_TENANT_ID;
const CLIENT_ID = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiry = 0;

function request(options, body) {
  return new Promise((resolve) => {
    const r = https.request(options, (re) => {
      let d = '';
      re.on('data', (c) => (d += c));
      re.on('end', () => {
        let parsed = null;
        try { parsed = d ? JSON.parse(d) : null; } catch (e) { parsed = { raw: d }; }
        resolve({ status: re.statusCode, data: parsed });
      });
    });
    r.on('error', (e) => resolve({ status: 0, data: { error: { message: e.message } } }));
    if (body) r.write(body);
    r.end();
  });
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (!TENANT || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Graph non configuré — GRAPH_TENANT_ID, GRAPH_CLIENT_ID et GRAPH_CLIENT_SECRET requis');
  }
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  }).toString();
  const r = await request({
    hostname: 'login.microsoftonline.com',
    path: '/' + TENANT + '/oauth2/v2.0/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(form),
    },
  }, form);
  if (r.status !== 200 || !r.data || !r.data.access_token) {
    const msg = (r.data && (r.data.error_description || r.data.error)) || 'réponse inattendue';
    throw new Error('Jeton Graph refusé (' + r.status + ') : ' + msg);
  }
  cachedToken = r.data.access_token;
  tokenExpiry = Date.now() + (r.data.expires_in - 300) * 1000;
  return cachedToken;
}

async function graph(method, urlPath, body) {
  const token = await getToken();
  const payload = body ? JSON.stringify(body) : null;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
  const r = await request({
    hostname: 'graph.microsoft.com',
    path: '/v1.0' + urlPath,
    method,
    headers,
  }, payload);
  if (r.status >= 400) {
    const msg = (r.data && r.data.error && r.data.error.message) || 'erreur Graph';
    const err = new Error('Graph ' + method + ' ' + urlPath + ' → ' + r.status + ' : ' + msg);
    err.status = r.status;
    throw err;
  }
  return r.data;
}

const box = () => '/users/' + encodeURIComponent(MAILBOX);

// ---- Lecture ------------------------------------------------------------

async function listerMessages({ depuis, limite = 50, dossier = 'inbox' } = {}) {
  const champs = 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,' +
    'bodyPreview,hasAttachments,importance,isRead,isDraft,internetMessageId,webLink,categories';
  let p = box() + '/mailFolders/' + dossier + '/messages?$top=' + limite +
    '&$orderby=receivedDateTime desc&$select=' + champs;
  if (depuis) p += "&$filter=" + encodeURIComponent('receivedDateTime ge ' + new Date(depuis).toISOString());
  const d = await graph('GET', p);
  return (d && d.value) || [];
}

async function lireMessage(id) {
  return graph('GET', box() + '/messages/' + id +
    '?$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,importance,categories,webLink');
}

async function listerPiecesJointes(id) {
  const d = await graph('GET', box() + '/messages/' + id + '/attachments?$select=id,name,size,contentType');
  return (d && d.value) || [];
}

// ---- Écriture (N1+) -----------------------------------------------------

async function categoriser(id, categories) {
  return graph('PATCH', box() + '/messages/' + id, { categories });
}

async function marquerLu(id, lu = true) {
  return graph('PATCH', box() + '/messages/' + id, { isRead: lu });
}

async function deplacer(id, dossierId) {
  return graph('POST', box() + '/messages/' + id + '/move', { destinationId: dossierId });
}

// ---- Brouillons (N2) ----------------------------------------------------

// Crée un brouillon de réponse rattaché au fil de discussion, puis y injecte le corps.
async function creerBrouillonReponse(messageId, corpsHtml, { repondreATous = false } = {}) {
  const action = repondreATous ? '/createReplyAll' : '/createReply';
  const brouillon = await graph('POST', box() + '/messages/' + messageId + action, {});
  const corpsExistant = (brouillon.body && brouillon.body.content) || '';
  await graph('PATCH', box() + '/messages/' + brouillon.id, {
    body: { contentType: 'HTML', content: corpsHtml + corpsExistant },
  });
  return brouillon.id;
}

async function majBrouillon(brouillonId, corpsHtml) {
  return graph('PATCH', box() + '/messages/' + brouillonId, {
    body: { contentType: 'HTML', content: corpsHtml },
  });
}

async function supprimerBrouillon(brouillonId) {
  return graph('DELETE', box() + '/messages/' + brouillonId);
}

// ---- Envoi (N3 — jamais appelé sans approbation explicite) ---------------

async function envoyerBrouillon(brouillonId) {
  return graph('POST', box() + '/messages/' + brouillonId + '/send', null);
}

async function verifierAcces() {
  const d = await graph('GET', box() + '?$select=mail,displayName');
  return { boite: d.mail || MAILBOX, nom: d.displayName };
}

module.exports = {
  graph, listerMessages, lireMessage, listerPiecesJointes,
  categoriser, marquerLu, deplacer,
  creerBrouillonReponse, majBrouillon, supprimerBrouillon, envoyerBrouillon,
  verifierAcces,
};
