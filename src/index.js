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
cron.schedule(CRON_SCHEDULE, async () => {
  console.log('[INFO] Cron déclenché —', new Date().toISOString());
  const r = await syncComplet();
  if (r.skipped) console.log('[INFO] Cron ignoré —', r.reason);
  else console.log('[INFO] Cron terminé en ' + r.duree_s + 's — ok:', r.ok);
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

app.listen(PORT, () => {
  console.log('[INFO] Bridge Avantage v7 démarré sur le port ' + PORT);
  console.log('[INFO] Export dir:', EXPORT_DIR);
  console.log('[INFO] Cron:', CRON_SCHEDULE);
});
