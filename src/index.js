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
