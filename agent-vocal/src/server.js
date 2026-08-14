const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const { config } = require('./config');
const { store } = require('./db');
const { clients } = require('./clients');
const horaire = require('./horaire');
const { SessionAppel } = require('./moteur/session');
const { LigneTwilio, twimlAccueil, signatureValide } = require('./telephonie/twilio');
const { tbc } = require('./telephonie/telus-business-connect');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const serveur = http.createServer(app);

// ── Site vitrine et console ──────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'web/site.html')));
app.get('/console', (req, res) => res.sendFile(path.join(__dirname, 'web/console.html')));

// ── Etat du service ──────────────────────────────────────────────────────────
app.get('/api/sante', (req, res) => {
  const manquants = config.verifier();
  res.json({
    service: 'standard24',
    version: require('../package.json').version,
    pret: manquants.length === 0,
    configuration_manquante: manquants,
    clients_actifs: clients.tous().filter((c) => c.actif).length,
    telus_business_connect: tbc.disponible(),
  });
});

// ── Telephonie : arrivee d'un appel ──────────────────────────────────────────
app.post('/twilio/voix', (req, res) => {
  const url = `${config.urlPublique}/twilio/voix`;
  if (!signatureValide(url, req.body, req.get('X-Twilio-Signature'))) {
    console.warn('[AVIS] Signature Twilio invalide — appel refuse');
    return res.status(403).send('Signature invalide');
  }

  const appele = req.body.To;
  const appelant = req.body.From;
  const client = clients.parNumero(appele);

  if (!client || !client.actif) {
    console.warn(`[AVIS] Aucun client actif pour le numero ${appele}`);
    return res
      .type('text/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="fr-CA">` +
          `Ce numéro n'est pas en service. Au revoir.</Say><Hangup/></Response>`
      );
  }

  const wsUrl = `${config.urlPublique.replace(/^http/, 'ws')}/media`;
  res.type('text/xml').send(
    twimlAccueil(wsUrl, {
      client: client.id,
      appelant: appelant || '',
      appele: appele || '',
    })
  );
});

// ── Telephonie : flux audio bidirectionnel ───────────────────────────────────
const wss = new WebSocketServer({ server: serveur, path: '/media' });

wss.on('connection', (ws) => {
  let session = null;
  let ligne = null;

  ws.on('message', (brut) => {
    let msg;
    try {
      msg = JSON.parse(brut.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start': {
        const p = msg.start.customParameters || {};
        const client = clients.parId(p.client);
        if (!client) {
          console.error(`[ERREUR] Client inconnu dans le flux : ${p.client}`);
          ws.close();
          return;
        }
        ligne = new LigneTwilio(ws, {
          callSid: msg.start.callSid,
          streamSid: msg.start.streamSid,
        });
        session = new SessionAppel({
          client,
          ligne,
          appelant: p.appelant || null,
          numeroAppele: p.appele || null,
        });
        console.log(
          `[INFO] Appel entrant ${session.id} — ${client.nom} — de ${p.appelant || 'numero masque'} — ` +
            `entreprise ${horaire.estOuvert(client) ? 'ouverte' : 'fermee'}`
        );
        session.demarrer();
        break;
      }

      case 'media':
        if (session) session.ecoute.envoyer(Buffer.from(msg.media.payload, 'base64'));
        break;

      case 'mark':
        if (ligne) ligne.confirmerMarque(msg.mark.name);
        break;

      case 'stop':
        if (session) session.fermer(session.contexte.denouement || 'raccroche');
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (session && !session.terminee) session.fermer(session.contexte.denouement || 'raccroche');
  });

  ws.on('error', (e) => console.error(`[ERREUR] WebSocket media : ${e.message}`));
});

// ── Console d'administration ─────────────────────────────────────────────────
function admin(req, res, suite) {
  const cle = req.get('X-Cle-Admin') || req.query.cle;
  if (cle !== config.cleAdmin) return res.status(401).json({ erreur: 'Clé invalide' });
  return suite();
}

app.get('/api/clients', admin, (req, res) => {
  res.json(
    clients.tous().map((c) => ({
      id: c.id,
      nom: c.nom,
      secteur: c.secteur,
      actif: c.actif,
      numero_agent: c.numero_agent,
      ouvert: horaire.estOuvert(c),
      statistiques: store.statistiques(c.id),
    }))
  );
});

app.get('/api/clients/:id', admin, (req, res) => {
  const c = clients.parId(req.params.id);
  if (!c) return res.status(404).json({ erreur: 'Client introuvable' });
  res.json(c);
});

app.put('/api/clients/:id', admin, (req, res) => {
  try {
    const c = clients.enregistrer(req.params.id, req.body);
    res.json(c);
  } catch (e) {
    res.status(400).json({ erreur: e.message });
  }
});

app.get('/api/clients/:id/appels', admin, (req, res) =>
  res.json(store.listerAppels(req.params.id, parseInt(req.query.limite || '50', 10)))
);

app.get('/api/appels/:id', admin, (req, res) => {
  const a = store.detailAppel(req.params.id);
  if (!a) return res.status(404).json({ erreur: 'Appel introuvable' });
  res.json({ ...a, transcription: a.transcription ? JSON.parse(a.transcription) : [] });
});

app.get('/api/clients/:id/messages', admin, (req, res) =>
  res.json(store.listerMessages(req.params.id))
);

app.get('/api/clients/:id/rendezvous', admin, (req, res) =>
  res.json(store.listerRdv(req.params.id))
);

app.post('/api/recharger', admin, (req, res) => {
  const n = clients.recharger();
  res.json({ ok: true, clients: n });
});

// ── Demandes de démo depuis le site vitrine ──────────────────────────────────
app.post('/api/demo', (req, res) => {
  const { entreprise, nom, courriel, telephone, secteur, volume, message } = req.body || {};
  if (!entreprise || !nom || !(courriel || telephone)) {
    return res.status(400).json({ erreur: 'Entreprise, nom et une coordonnée sont requis.' });
  }
  store.journaliser(null, '_prospects', 'demande_demo', {
    entreprise, nom, courriel, telephone, secteur, volume, message,
  });
  console.log(`[INFO] Demande de démo — ${entreprise} (${nom})`);
  res.json({ ok: true });
});

// ── Démarrage ────────────────────────────────────────────────────────────────
const nb = clients.recharger();
const manquants = config.verifier();

serveur.listen(config.port, () => {
  console.log(`[INFO] Standard 24 démarré sur le port ${config.port}`);
  console.log(`[INFO] ${nb} client(s) chargé(s) : ${clients.tous().map((c) => c.id).join(', ') || 'aucun'}`);
  console.log(`[INFO] URL publique : ${config.urlPublique || 'NON CONFIGURÉE'}`);
  console.log(`[INFO] Telus Business Connect : ${tbc.disponible() ? 'connecté' : 'non configuré'}`);
  if (manquants.length) {
    console.warn(`[AVIS] Configuration incomplète — aucun appel ne pourra aboutir. Manque : ${manquants.join(', ')}`);
  }
});
