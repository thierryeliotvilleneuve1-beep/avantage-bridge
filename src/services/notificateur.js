// Envoi de notifications vers un webhook Teams (ou tout endpoint acceptant un POST JSON).
//
// Canal unique et sans authentification à stocker : un webhook entrant Teams. Si
// TEAMS_WEBHOOK_URL n'est pas défini, toutes les notifications deviennent des no-op
// silencieux — le bridge fonctionne sans alertes, sans erreur.
//
// Payload volontairement générique { text } (Markdown) : accepté par un connecteur
// « Incoming Webhook » classique comme par un flux Power Automate qui lit `text`.

const https = require('https');
const { URL } = require('url');

function webhookUrl() {
  return (process.env.TEAMS_WEBHOOK_URL || '').trim();
}

function disponible() {
  return Boolean(webhookUrl());
}

// Envoie un message. Ne rejette jamais : renvoie {ok|skipped|error} pour journalisation.
function envoyer(titre, texte, opts) {
  const url = webhookUrl();
  if (!url) return Promise.resolve({ skipped: true, raison: 'TEAMS_WEBHOOK_URL non défini' });

  const prefixe = (opts && opts.emoji ? opts.emoji + ' ' : '');
  const corps = (titre ? '**' + prefixe + titre + '**\n\n' : '') + (texte || '');
  const payload = JSON.stringify({ text: corps });

  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ error: 'URL webhook invalide' }); }
    const o = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      port: u.port || 443,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    };
    const req = https.request(o, (re) => {
      let d = '';
      re.on('data', c => d += c);
      re.on('end', () => resolve({ ok: re.statusCode >= 200 && re.statusCode < 300, status: re.statusCode }));
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(payload);
    req.end();
  });
}

module.exports = { envoyer, disponible };
