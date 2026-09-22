require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'CHANGE_MOI_CLE_SECRETE_LONGUE';
// Même résolution que src/sources/donneesAvantage.js, pour que /api/status annonce
// le répertoire réellement lu.
const EXPORT_DIR = process.env.AVANTAGE_EXPORT_DIR
  ? path.resolve(process.env.AVANTAGE_EXPORT_DIR)
  : path.resolve(__dirname, '../exports-avantage');
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/15 * * * *';

// Auth middleware
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Clé API manquante ou invalide' });
  next();
}

// Route status — publique
app.get('/api/status', (req, res) => {
  let depotDbf = null;
  try { depotDbf = require('./sources/depotDbf').disponible() ? require('./sources/depotDbf').repertoire() : null; } catch (e) {}
  const { etat } = require('./services/syncComplet');
  res.json({
    ok: true, service: 'avantage-bridge', version: '7.2.0', export_dir: EXPORT_DIR,
    source: depotDbf ? ('dbf:' + depotDbf) : 'csv',
    sync: etat(),
  });
});

// Routes — protégées
const budgetRouter = require('./routes/budget');
const bcSyncRouter = require('./routes/bc-sync');
const transSyncRouter = require('./routes/trans-sync');
const etatResultatsRouter = require('./routes/etat-resultats');

app.use('/api/budget', auth, budgetRouter);
app.use('/api/bc', auth, bcSyncRouter);
app.use('/api/trans', auth, transSyncRouter);
// État des résultats — lecture seule dans Avantage, n'écrit rien.
app.use('/api/etat-resultats', auth, etatResultatsRouter);

// Cron sync — cycle complet : projets, factures, transactions, lus dans la base .DBF.
const { syncComplet } = require('./services/syncComplet');
// CRON_ACTIF=false met le sync automatique en pause (utile pendant le chargement
// initial ou les tests manuels). Le bridge répond toujours aux appels manuels.
const CRON_ACTIF = process.env.CRON_ACTIF !== 'false';
if (CRON_ACTIF) {
  cron.schedule(CRON_SCHEDULE, async () => {
    console.log('[INFO] Cron déclenché —', new Date().toISOString());
    const r = await syncComplet();
    if (r.skipped) console.log('[INFO] Cron ignoré —', r.reason);
    else console.log('[INFO] Cron terminé en ' + r.duree_s + 's — ok:', r.ok);
  });
} else {
  console.log('[INFO] Cron en pause (CRON_ACTIF=false) — sync manuel seulement');
}

// ── Notifications, alertes budgétaires et résumé hebdo IA ────────────────────────
const notificateur = require('./services/notificateur');
const resumeHebdo = require('./services/resumeHebdo');

// Surveillance de fraîcheur : si le dernier sync réussi est trop vieux alors que le cron
// est censé tourner, on alerte une fois (et on réarme quand ça repart). Garde-fou contre
// un bridge « silencieusement mort » (DBF illisible, Base44 down, PC en veille prolongée).
const FRAICHEUR_MIN = parseInt(process.env.MONITEUR_FRAICHEUR_MIN, 10) || 45;
let alerteStaleEnvoyee = false;
if (CRON_ACTIF) {
  setInterval(async () => {
    try {
      const d = require('./services/syncComplet').etat().dernier;
      if (!d || !d.fin) return; // jamais tourné depuis le démarrage : on attend
      const ageMin = (Date.now() - new Date(d.fin).getTime()) / 60000;
      if (ageMin > FRAICHEUR_MIN && !alerteStaleEnvoyee) {
        alerteStaleEnvoyee = true;
        if (notificateur.disponible()) await notificateur.envoyer('Sync Avantage en retard',
          'Aucun sync réussi depuis ' + Math.round(ageMin) + ' min (seuil ' + FRAICHEUR_MIN + ' min). ' +
          'Vérifier PM2, la connexion Base44 et l\'accès A:\\AVA01.', { emoji: '🟠' });
      } else if (ageMin <= FRAICHEUR_MIN && alerteStaleEnvoyee) {
        alerteStaleEnvoyee = false; // repart : on réarme l'alerte
        if (notificateur.disponible()) await notificateur.envoyer('Sync Avantage rétabli', 'Le sync a repris normalement.', { emoji: '🟢' });
      }
    } catch (e) {}
  }, Math.max(5, Math.floor(FRAICHEUR_MIN / 3)) * 60 * 1000);
}

// Résumé hebdomadaire IA (par défaut lundi 7h). Nécessite ANTHROPIC_API_KEY.
const RESUME_HEBDO_CRON = process.env.RESUME_HEBDO_CRON || '0 7 * * 1';
if (resumeHebdo.actif()) {
  cron.schedule(RESUME_HEBDO_CRON, async () => {
    console.log('[INFO] Résumé hebdo déclenché —', new Date().toISOString());
    try { const r = await resumeHebdo.genererEtEnvoyer(); console.log('[INFO] Résumé hebdo:', r.ok ? (r.projets + ' projets') : r.raison); }
    catch (e) { console.error('[INFO] Résumé hebdo échec:', e.message); }
  });
  console.log('[INFO] Résumé hebdo IA:', RESUME_HEBDO_CRON, '(modèle', (process.env.ANTHROPIC_MODEL || 'claude-opus-5') + ')');
}

// Déclencheurs manuels (tests / à la demande)
app.post('/api/resume-hebdo', auth, async (req, res) => {
  try { res.json(await resumeHebdo.genererEtEnvoyer()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/test-alerte', auth, async (req, res) => {
  const r = await notificateur.envoyer('Test alerte bridge', 'Ceci est un test du canal de notification Teams.', { emoji: '✅' });
  res.json(r);
});
// Prend la photo hebdomadaire du budget à la demande (normalement déclenchée par le sync).
app.post('/api/snapshot-budget', auth, async (req, res) => {
  try { res.json(await require('./services/snapshotBudget').prendreSnapshot()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Sonde TCP LECTURE SEULE de la passerelle SDK Avantage (maintcp.exe). N'ÉCRIT JAMAIS dans
// Avantage : envoie un jeton invalide et rapporte la connexion + la réponse éventuelle.
// Ex.: /api/sdk-probe?ports=3000,5000,9100  (ou ?port=XXXX). host=127.0.0.1 par défaut.
app.get('/api/sdk-probe', auth, async (req, res) => {
  try {
    const host = req.query.host || '127.0.0.1';
    const ports = (req.query.ports || req.query.port || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ports.length) return res.status(400).json({ ok: false, error: 'Préciser ?port=XXXX ou ?ports=a,b,c' });
    const timeoutMs = Math.min(parseInt(req.query.timeout, 10) || 4000, 15000);
    // payload optionnel ; par défaut jeton bidon (lecture seule, jamais une requête d'écriture).
    const payload = req.query.payload != null ? req.query.payload : undefined;
    res.json(await require('./services/sdkProbe').sonder({ host, ports, payload, timeoutMs }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Dialogue LECTURE SEULE avec la passerelle SDK (maintcp). POST JSON :
//   { "port":2131, "commandes":["<cmd1>","<cmd2>"], "timeoutMs":8000, "attenteMs":900 }
// GARDE-FOU : toute commande contenant un op d'écriture (W..) est REFUSÉE.
app.post('/api/sdk-dialogue', auth, async (req, res) => {
  try {
    const b = req.body || {};
    let commandes = Array.isArray(b.commandes) ? b.commandes : (b.commandes ? [b.commandes] : []);
    if (!commandes.length) return res.status(400).json({ ok: false, error: 'commandes[] requis' });
    // Sentinel {{LOGIN}} → commande LOGIN construite depuis le .env, jamais exposée.
    const comp = process.env.AVANTAGE_SDK_COMPAGNIE || '01';
    const user = process.env.AVANTAGE_SDK_USER || '';
    const pass = process.env.AVANTAGE_SDK_PASS || '';
    commandes = commandes.map(c => String(c) === '{{LOGIN}}' ? ('LOGIN,' + comp + ',' + user + ',' + pass) : c);
    const ecriture = commandes.find(c => /(^|,)\s*W\d/i.test(String(c)));
    if (ecriture) return res.status(400).json({ ok: false, error: 'Commande d\'écriture BLOQUÉE (op W..) : ' + (String(ecriture).replace(pass || '\0', '****')) });
    const r = await require('./services/maintcpClient').dialoguer({
      host: b.host, port: b.port || 2131, commandes,
      timeoutMs: b.timeoutMs, attenteMs: b.attenteMs, finLigne: b.finLigne,
    });
    // Rédaction : le mot de passe ne doit jamais ressortir dans la réponse.
    if (pass) {
      const red = (s) => (typeof s === 'string' ? s.split(pass).join('****') : s);
      if (r.banniere) r.banniere = red(r.banniere);
      if (Array.isArray(r.echanges)) r.echanges.forEach(e => { e.envoye = red(e.envoye); e.recu = red(e.recu); });
      if (r.reste) r.reste = red(r.reste);
    }
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Lecture d'un contrat CONTRA en clair via la passerelle SDK (LECTURE SEULE).
app.get('/api/sdk/contrat/:code', auth, async (req, res) => {
  try {
    const { interroger, parseCsv } = require('./services/maintcpClient');
    const conum = String(req.params.code).replace(/^P/i, '').trim().padStart(10, '0');
    const r = await interroger({ op: 'R01', mnemonique: 'CNT', index: 'CONUM', valeur: conum });
    if (!r.ok) return res.status(502).json(r);
    res.json({ ok: true, conum, count: r.count, contrats: r.lignes.map(parseCsv) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Synchronise les noms de projets depuis CONTRA (via SDK) — LECTURE SEULE, non destructif.
app.post('/api/sdk/noms-projets', auth, async (req, res) => {
  try {
    const { apiGetAll } = require('./writers/base44-writer');
    const ctx = { projets: await apiGetAll('Projet') };
    res.json(await require('./services/syncContraNoms').synchroniser(ctx));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Diagnostic : quels projets actifs ne matchent aucun contrat CONTRA (les « introuvables »).
app.get('/api/sdk/diagnostic-projets', auth, async (req, res) => {
  try {
    const { apiGetAll } = require('./writers/base44-writer');
    const ctx = { projets: await apiGetAll('Projet') };
    res.json(await require('./services/syncContraNoms').diagnostiquer(ctx));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Engagé réel d'un projet (COMMAN via R09, LECTURE SEULE) : BC fournisseurs + total engagé.
app.get('/api/sdk/engage/:code', auth, async (req, res) => {
  try {
    const r = await require('./services/lectureEngage').lireEngage(req.params.code);
    if (!r.ok) return res.status(502).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Engagé réel VENTILÉ PAR DIVISION (COMITE via R09). LECTURE SEULE — à valider avant écriture.
app.get('/api/sdk/engage-divisions/:code', auth, async (req, res) => {
  try {
    const r = await require('./services/lectureEngage').lireEngageDivisions(req.params.code);
    if (!r.ok) return res.status(502).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Lecteur générique de table Avantage (R09 = lit toute table par nom). LECTURE SEULE.
// GET /api/sdk/table/:nom?index=IDX&valeur=VAL&op=R09
app.get('/api/sdk/table/:nom', auth, async (req, res) => {
  try {
    const { interroger, parseCsv } = require('./services/maintcpClient');
    const r = await interroger({
      op: req.query.op || 'R09',
      mnemonique: String(req.params.nom).toUpperCase(),
      index: req.query.index,
      valeur: req.query.valeur,
    });
    if (!r.ok) return res.status(502).json(r);
    res.json({ ok: true, count: r.count, lignes: r.lignes.map(parseCsv) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Explorateur SDK (LECTURE SEULE) : cartographie l'op/mnémonique de FACTMA & COMMAN.
// Corps attendu : { "combinaisons": [ { "op":"R02", "mnemonique":"FMA", "index":"FFCONT", "valeur":"0000026008" }, ... ] }
app.post('/api/sdk/explorer', auth, async (req, res) => {
  try {
    const { explorer } = require('./services/maintcpClient');
    const body = req.body || {};
    const combinaisons = Array.isArray(body.combinaisons) ? body.combinaisons : [];
    if (!combinaisons.length) return res.status(400).json({ ok: false, error: 'combinaisons[] requis' });
    res.json(await explorer(combinaisons, { maxEchantillon: body.maxEchantillon }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Recopie les demandes de paiement (CONFIT) à la demande (normalement déclenchée par le sync).
app.post('/api/demandes-paiement/sync', auth, async (req, res) => {
  try {
    const { chargerContexte } = require('./services/pousseurTransactions');
    const { apiGetAll } = require('./writers/base44-writer');
    const ctx = await chargerContexte();
    ctx.divisions = await apiGetAll('ControleBudgetaire');
    res.json(await require('./services/pousseurDemandesPaiement').pousserToutesDemandes(ctx));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Sync manuel complet
app.post('/api/sync/all', auth, async (req, res) => {
  const codes = req.query.projets ? req.query.projets.split(',') : null;
  res.json(await syncComplet({ codes }));
});
app.post('/api/sync/projet/:code', auth, async (req, res) => {
  res.json(await syncComplet({ codes: [req.params.code] }));
});
app.get('/api/sync/etat', auth, (req, res) => res.json(require('./services/syncComplet').etat()));

// Aperçu budgétaire (LECTURE SEULE) — reconstruit le « Suivi de projet » d'Avantage
// depuis la BD, pour comparaison avec l'écran avant tout écriture dans Manoeuvre.
app.get('/api/budget/apercu/:code', auth, (req, res) => {
  try { res.json(require('./sources/budgetDbf').apercu(req.params.code)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Aperçu d'une demande de paiement reconstruite depuis CONFIT (LECTURE SEULE), pour
// comparaison au cent près avec l'écran « demande de paiement » d'Avantage avant tout
// écriture dans Manoeuvre.
app.get('/api/demandes-paiement/apercu/:code', auth, (req, res) => {
  try {
    const dp = require('./sources/demandesPaiementDbf');
    if (!dp.disponible()) return res.status(503).json({ ok: false, error: 'CONFIT introuvable dans ' + dp.repertoire() });
    const r = dp.lireProjet(req.params.code);
    if (!r) return res.status(404).json({ ok: false, error: 'Aucune ligne CONFIT pour le projet ' + req.params.code });
    res.json({ ok: true, projet: req.params.code, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Inspection d'une table .DBF (LECTURE SEULE) — colonnes, lisibilité et quelques
// enregistrements. Sert à cartographier une table (ex. COMMAN) avant d'écrire son
// lecteur, sans jamais exporter vers Excel ni écrire dans Avantage.
app.get('/api/inspect/:table', auth, async (req, res) => {
  try {
    const depot = require('./sources/depotDbf');
    if (!depot.disponible()) return res.status(503).json({ ok: false, error: depot.raisonIndisponible() });
    const table = req.params.table.toUpperCase();
    if (!depot.aTable(table)) return res.status(404).json({ ok: false, error: 'Table ' + table + ' introuvable dans ' + depot.repertoire() });
    const n = Math.min(parseInt(req.query.n, 10) || 5, 50);
    const colonnes = await depot.listerColonnes(table);
    let lisibilite = null; try { lisibilite = depot.lisibilite(table); } catch (e) {}
    let echantillon = []; try { echantillon = (await depot.echantillonner(table, n)).slice(0, n); } catch (e) {}
    res.json({ ok: true, table, repertoire: depot.repertoire(), colonnes, lisibilite, echantillon });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => {
  console.log('[INFO] Bridge Avantage v7 démarré sur le port ' + PORT);
  console.log('[INFO] Export dir:', EXPORT_DIR);
  console.log('[INFO] Cron:', CRON_ACTIF ? CRON_SCHEDULE : 'PAUSE (CRON_ACTIF=false)');
});
