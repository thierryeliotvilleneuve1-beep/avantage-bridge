// Sonde TCP LECTURE SEULE de la passerelle SDK Avantage (maintcp.exe).
//
// But : vérifier si maintcp écoute et s'il répond, SANS jamais écrire dans Avantage.
// On envoie un jeton VOLONTAIREMENT INVALIDE (pas une requête RQ01,W.. valide) : aucun
// parseur ne peut créer/modifier quoi que ce soit à partir de ça. On observe seulement
// la connexion et la réponse éventuelle.
//
// maintcp.exe tourne sur le PC où Avantage est installé ; ce probe s'exécute donc sur ce
// même PC (via le bridge), en visant 127.0.0.1 par défaut.

const net = require('net');

// Jeton bidon : ne correspond à AUCUNE commande d'écriture du SDK (qui commence par RQ01,W..).
const JETON_BIDON = 'PROBE-CRC-LECTURE-SEULE\r\n';

function apercu(buf) {
  if (!buf || !buf.length) return null;
  return {
    octets: buf.length,
    texte: buf.toString('latin1').slice(0, 800),   // aperçu lisible
    hex: buf.slice(0, 96).toString('hex'),          // début en hexa (diagnostic)
  };
}

// Sonde un seul port. Ne renvoie jamais d'erreur non capturée.
function sonderPort({ host = '127.0.0.1', port, payload = JETON_BIDON, timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    if (!port) return resolve({ port, ok: false, error: 'port requis' });
    const t0 = Date.now();
    const sock = new net.Socket();
    let recu = Buffer.alloc(0);
    let fini = false;
    const fin = (r) => {
      if (fini) return; fini = true;
      try { sock.destroy(); } catch (e) {}
      resolve(Object.assign({ host, port, duree_ms: Date.now() - t0 }, r));
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => { try { if (payload) sock.write(payload); } catch (e) {} });
    sock.on('data', (d) => {
      recu = Buffer.concat([recu, d]);
      if (recu.length > 65536) fin({ ok: true, connecte: true, reponse_recue: true, apercu: apercu(recu) });
    });
    sock.on('timeout', () => fin({
      ok: true, connecte: true, reponse_recue: recu.length > 0,
      note: recu.length
        ? 'connecté, réponse reçue avant le délai'
        : 'connecté mais AUCUNE réponse (maintcp écoute peut-être mais n\'émet rien sur un jeton invalide, ou attend un autre cadrage/handshake)',
      apercu: apercu(recu),
    }));
    sock.on('error', (e) => fin({
      ok: false, connecte: false, code: e.code, error: e.message,
      note: e.code === 'ECONNREFUSED' ? 'rien n\'écoute sur ce port'
        : e.code === 'ETIMEDOUT' ? 'hôte injoignable / filtré'
        : '',
    }));
    sock.on('close', () => fin({ ok: true, connecte: true, reponse_recue: recu.length > 0, apercu: apercu(recu) }));
    sock.connect(port, host);
  });
}

// Sonde une liste de ports en série (utile pour découvrir le port de maintcp).
async function sonder({ host = '127.0.0.1', ports, payload, timeoutMs = 4000 }) {
  const liste = (Array.isArray(ports) ? ports : [ports]).map(p => parseInt(p, 10)).filter(Boolean);
  const resultats = [];
  for (const port of liste) {
    resultats.push(await sonderPort({ host, port, payload, timeoutMs }));
  }
  return {
    host,
    testes: liste,
    ouverts: resultats.filter(r => r.connecte).map(r => r.port),
    avec_reponse: resultats.filter(r => r.reponse_recue).map(r => r.port),
    resultats,
  };
}

module.exports = { sonder, sonderPort, JETON_BIDON };
