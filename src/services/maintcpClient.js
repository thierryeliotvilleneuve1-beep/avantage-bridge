// Client de la passerelle SDK Avantage (maintcp.exe, TCP port 2131).
//
// LECTURE SEULE. Deux usages :
//   • dialoguer()  : mise au point (séquence de commandes brutes, réponses capturées).
//   • interroger() : requête de lecture structurée (LOGIN + RQ01,R0x,,MNÉMO,INDEX[,valeur]),
//                    réponse CSV parsée en enregistrements.
//
// Protocole (décodé — voir vault 06-Skills/Bridge-Avantage-Manoeuvre/SDK-Avantage-maintcp-Protocole.md) :
//   connexion → bannière → LOGIN,<compagnie>,<usager>,<motdepasse> → LOGIN,OK,...
//   puis      → RQ01,<op>,,<mnémo>,<index>[,"valeur"] → RQ01,<op>,OK,BEGIN\n<lignes>\nRQ01,<op>,OK,END,<n>
//
// Identifiants lus dans le .env (AVANTAGE_SDK_*), jamais codés en dur. Op d'écriture (W..) jamais émis.

const net = require('net');

function cfg() {
  return {
    host: process.env.AVANTAGE_SDK_HOST || '127.0.0.1',
    port: parseInt(process.env.AVANTAGE_SDK_PORT, 10) || 2131,
    compagnie: process.env.AVANTAGE_SDK_COMPAGNIE || '01',
    usager: process.env.AVANTAGE_SDK_USER || '',
    motdepasse: process.env.AVANTAGE_SDK_PASS || '',
  };
}

function actif() {
  return process.env.AVANTAGE_SDK_ACTIF === 'true' && Boolean((process.env.AVANTAGE_SDK_USER || '').trim());
}

// Découpe une ligne CSV Avantage (champs entre guillemets, virgules internes protégées, "" échappé).
function parseCsv(ligne) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (q) {
      if (c === '"') { if (ligne[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Découpe le bloc de réponse en enregistrements. Universel : un enregistrement par ligne.
// (CONTRA/COMMAN terminent chaque ligne par ,"AVANTAGE" ; COMITE non — le découpage par
// saut de ligne fonctionne dans les deux cas. Les champs Avantage n'ont pas de \n interne.)
function decouperEnregistrements(bloc) {
  if (!bloc) return [];
  return bloc.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

// Requête de lecture. valeur optionnelle = filtre exact sur l'index (clé zéro-paddée au besoin).
function interroger(o) {
  const c = cfg();
  const op = (o && o.op) || 'R01';
  const mnemonique = o && o.mnemonique;
  const index = o && o.index;
  const valeur = o && o.valeur;
  const timeoutMs = (o && o.timeoutMs) || 20000;
  const host = (o && o.host) || c.host;
  const port = (o && o.port) || c.port;

  // Garde-fou absolu : jamais d'op d'écriture.
  if (/^W/i.test(op)) return Promise.resolve({ ok: false, erreur: 'op d\'écriture interdit (' + op + ')' });

  const req = 'RQ01,' + op + ',,' + mnemonique + ',' + index +
    (valeur != null && valeur !== '' ? (',"' + valeur + '"') : '');

  return new Promise((resolve) => {
    const sock = new net.Socket();
    let buf = ''; let etape = 'banniere'; let fini = false;
    const fin = (r) => { if (fini) return; fini = true; try { sock.destroy(); } catch (e) {} resolve(r); };
    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => fin({ ok: false, erreur: 'délai dépassé', brut: buf.slice(0, 500) }));
    sock.on('error', (e) => fin({ ok: false, erreur: e.message, code: e.code }));
    sock.on('close', () => { if (!fini) fin({ ok: false, erreur: 'connexion fermée', brut: buf.slice(0, 500) }); });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (etape === 'banniere') {
        if (buf.indexOf('\n') < 0) return;
        buf = ''; etape = 'login';
        sock.write('LOGIN,' + c.compagnie + ',' + c.usager + ',' + c.motdepasse + '\r\n');
        return;
      }
      if (etape === 'login') {
        const nl = buf.indexOf('\n'); if (nl < 0) return;
        const ligne = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (/^LOGIN,OK/i.test(ligne)) { etape = 'req'; sock.write(req + '\r\n'); }
        else fin({ ok: false, erreur: 'login refusé : ' + ligne.trim() });
        return;
      }
      if (etape === 'req') {
        const errm = buf.match(/RQ01,[^,]+,ERR,"([^"]*)"/);
        if (errm) { fin({ ok: false, erreur: errm[1], requete: req }); return; }
        const endm = buf.match(/,OK,END,(\d+)/);
        if (endm) {
          const b = buf.match(/,OK,BEGIN\r?\n([\s\S]*?)\r?\nRQ01,[^,]+,OK,END,\d+/);
          const bloc = b ? b[1] : '';
          const lignes = decouperEnregistrements(bloc);
          fin({ ok: true, requete: req, count: parseInt(endm[1], 10), lignes });
        }
      }
    });
    sock.connect(port, host);
  });
}

// ── Outil de dialogue brut (mise au point) — inchangé, avec garde-fou côté route. ──
function dialoguer(opts) {
  const o = opts || {}; const c = cfg();
  const host = o.host || c.host; const port = o.port || c.port;
  const commandes = Array.isArray(o.commandes) ? o.commandes : [];
  const timeoutMs = o.timeoutMs || 8000; const attenteMs = o.attenteMs || 900;
  const finLigne = o.finLigne != null ? o.finLigne : '\r\n';
  return new Promise((resolve) => {
    const t0 = Date.now(); const sock = new net.Socket();
    const echanges = []; let banniere = null; let buf = Buffer.alloc(0); let idx = -1; let fini = false;
    const fin = (extra) => { if (fini) return; fini = true; try { sock.destroy(); } catch (e) {} resolve(Object.assign({ host, port, duree_ms: Date.now() - t0, banniere, echanges }, extra)); };
    const vider = () => { const s = buf.toString('latin1'); buf = Buffer.alloc(0); return s; };
    const prochaine = () => {
      idx++;
      if (idx >= commandes.length) { setTimeout(() => fin({ ok: true }), attenteMs); return; }
      const cmd = String(commandes[idx]); buf = Buffer.alloc(0);
      try { sock.write(cmd + finLigne); } catch (e) {}
      setTimeout(() => { echanges.push({ envoye: cmd, recu: vider() }); prochaine(); }, attenteMs);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => { setTimeout(() => { banniere = vider(); prochaine(); }, attenteMs); });
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); });
    sock.on('timeout', () => fin({ ok: true, note: 'délai global', reste: vider() }));
    sock.on('error', (e) => fin({ ok: false, error: e.message, code: e.code }));
    sock.on('close', () => fin({ ok: true, note: 'connexion fermée par le serveur', reste: vider() }));
    sock.connect(port, host);
  });
}

// Explorateur : essaie une matrice de combinaisons {op,mnemonique,index,valeur} et rapporte,
// pour chacune, si la passerelle répond (ok/count/échantillon) ou l'erreur exacte. Sert à
// cartographier l'op/le mnémonique de lecture de FACTMA et COMMAN. LECTURE SEULE (les W.. sont bloqués).
async function explorer(combinaisons, opts) {
  const o = opts || {};
  const max = o.maxEchantillon != null ? o.maxEchantillon : 1;
  const resultats = [];
  for (const combo of (combinaisons || [])) {
    const r = await interroger(Object.assign({ op: 'R01', timeoutMs: o.timeoutMs || 15000 }, combo));
    resultats.push({
      requete: 'RQ01,' + (combo.op || 'R01') + ',,' + (combo.mnemonique || '') + ',' + (combo.index || '') +
        (combo.valeur ? (',"' + combo.valeur + '"') : ''),
      ok: r.ok,
      count: r.ok ? r.count : undefined,
      erreur: r.ok ? undefined : r.erreur,
      echantillon: r.ok ? (r.lignes || []).slice(0, max) : undefined,
    });
    await new Promise((res) => setTimeout(res, 120));
  }
  return { ok: true, essais: resultats.length, resultats };
}

module.exports = { interroger, dialoguer, explorer, parseCsv, decouperEnregistrements, actif, cfg };
