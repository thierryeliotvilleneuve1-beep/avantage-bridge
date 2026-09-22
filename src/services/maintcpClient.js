// Client de dialogue avec la passerelle SDK Avantage (maintcp.exe, TCP port 2131).
//
// LECTURE SEULE — un garde-fou (voir la route /api/sdk-dialogue) refuse toute commande
// contenant un op d'écriture (W..). Ici on ne fait qu'ouvrir une session, lire la bannière,
// envoyer des commandes en séquence et capturer les réponses. Sert à rétro-concevoir la
// grammaire LOGIN + lecture (R01..R10 / EXPORT) contre la passerelle verbeuse (mode DEBUG).
//
// Protocole observé : texte/CSV, réponse « <commande>,,<STATUT>,"<message>" ».

const net = require('net');

function dialoguer(opts) {
  const o = opts || {};
  const host = o.host || '127.0.0.1';
  const port = o.port || 2131;
  const commandes = Array.isArray(o.commandes) ? o.commandes : [];
  const timeoutMs = o.timeoutMs || 8000;      // sécurité globale
  const attenteMs = o.attenteMs || 900;       // délai d'attente d'une réponse avant d'enchaîner
  const finLigne = o.finLigne != null ? o.finLigne : '\r\n';

  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = new net.Socket();
    const echanges = [];
    let banniere = null;
    let buf = Buffer.alloc(0);
    let idx = -1;
    let fini = false;

    const fin = (extra) => {
      if (fini) return; fini = true;
      try { sock.destroy(); } catch (e) {}
      resolve(Object.assign({ host, port, duree_ms: Date.now() - t0, banniere, echanges }, extra));
    };
    const vider = () => { const s = buf.toString('latin1'); buf = Buffer.alloc(0); return s; };

    const prochaine = () => {
      idx++;
      if (idx >= commandes.length) { setTimeout(() => fin({ ok: true }), attenteMs); return; }
      const c = String(commandes[idx]);
      buf = Buffer.alloc(0);
      try { sock.write(c + finLigne); } catch (e) {}
      setTimeout(() => { echanges.push({ envoye: c, recu: vider() }); prochaine(); }, attenteMs);
    };

    sock.setTimeout(timeoutMs);
    sock.on('connect', () => { setTimeout(() => { banniere = vider(); prochaine(); }, attenteMs); });
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); });
    sock.on('timeout', () => fin({ ok: true, note: 'délai global atteint', reste: vider() }));
    sock.on('error', (e) => fin({ ok: false, error: e.message, code: e.code }));
    sock.on('close', () => fin({ ok: true, note: 'connexion fermée par le serveur', reste: vider() }));
    sock.connect(port, host);
  });
}

module.exports = { dialoguer };
