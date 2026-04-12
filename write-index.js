const fs = require('fs');

const content = `require('dotenv').config();
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
const EXPORT_DIR = path.resolve(__dirname, '../exports-avantage');
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/15 * * * *';

// Auth middleware
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Clé API manquante ou invalide' });
  next();
}

// Route status — publique
app.get('/api/status', (req, res) => {
  res.json({ ok: true, service: 'avantage-bridge', version: '7.0.0', export_dir: EXPORT_DIR });
});

// Routes — protégées
const budgetRouter = require('./routes/budget');
const bcSyncRouter = require('./routes/bc-sync');
const transSyncRouter = require('./routes/trans-sync');

app.use('/api/budget', auth, budgetRouter);
app.use('/api/bc', auth, bcSyncRouter);
app.use('/api/trans', auth, transSyncRouter);

// Cron sync
let lastSync = null;
cron.schedule(CRON_SCHEDULE, async () => {
  console.log('[INFO] Cron déclenché — refresh des données Avantage');
  try {
    const { parseContra } = require('./parsers/parseContra');
    const { parseFactma } = require('./parsers/parseFactma');
    const { writeProjets, writeFactures } = require('./writers/base44-writer');
    const contraPath = path.join(EXPORT_DIR, 'CONTRA.csv');
    const factmaPath = path.join(EXPORT_DIR, 'FACTMA.csv');
    if (!fs.existsSync(contraPath)) {
      console.log('[WARN] CONTRA.csv absent — aucun projet chargé');
      return;
    }
    const projets = parseContra(fs.readFileSync(contraPath, 'latin1'));
    console.log('[INFO] ' + projets.length + ' projets lus depuis CONTRA.csv');
    const pResult = await writeProjets(projets);
    console.log('[INFO] Projets — créés:', pResult.created, 'mis à jour:', pResult.updated, 'erreurs:', pResult.errors);
    if (fs.existsSync(factmaPath)) {
      const factures = parseFactma(fs.readFileSync(factmaPath, 'latin1'));
      console.log('[INFO] ' + factures.length + ' factures lues depuis FACTMA.csv');
      const fResult = await writeFactures(factures);
      console.log('[INFO] Factures — créées:', fResult.created, 'mises à jour:', fResult.updated, 'erreurs:', fResult.errors);
    }
    lastSync = new Date().toISOString();
    console.log('[INFO] Cron terminé —', new Date().toISOString());
  } catch (e) {
    console.error('[ERROR] Cron erreur:', e.message);
  }
});

app.listen(PORT, () => {
  console.log('[INFO] Bridge Avantage v7 démarré sur le port ' + PORT);
  console.log('[INFO] Export dir:', EXPORT_DIR);
  console.log('[INFO] Cron:', CRON_SCHEDULE);
});
`;

fs.writeFileSync('./src/index.js', content, 'utf8');
console.log('OK - index.js réécrit');
