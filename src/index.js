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
const EXPORT_DIR = path.resolve(__dirname, '../exports-avantage');
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/15 * * * *';

// Auth middleware
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Clé API manquante ou invalide' });
  next();
}

// Interface Adjointe IA — page servie en clair, l'API reste protégée par la clé
app.use('/adjointe', express.static(path.resolve(__dirname, '../public/adjointe')));

// Route status — publique
app.get('/api/status', (req, res) => {
  res.json({ ok: true, service: 'avantage-bridge', version: '7.0.0', export_dir: EXPORT_DIR });
});

// Routes — protégées
const budgetRouter = require('./routes/budget');
const bcSyncRouter = require('./routes/bc-sync');
const transSyncRouter = require('./routes/trans-sync');
const adjointeRouter = require('./routes/adjointe');

app.use('/api/budget', auth, budgetRouter);
app.use('/api/bc', auth, bcSyncRouter);
app.use('/api/trans', auth, transSyncRouter);
app.use('/api/adjointe', auth, adjointeRouter);

// Cron sync Avantage — CRON_SCHEDULE=off le désactive, pour permettre à une seconde
// instance (Adjointe IA) de tourner sans dupliquer la synchronisation comptable.
let lastSync = null;
if (CRON_SCHEDULE && CRON_SCHEDULE !== 'off') {
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
}

// Cron Adjointe IA — balayage de projets@c-rc.ca. Désactivé tant que
// ADJOINTE_CRON n'est pas défini : aucun accès à la boîte sans configuration explicite.
if (process.env.ADJOINTE_CRON) {
  cron.schedule(process.env.ADJOINTE_CRON, async () => {
    console.log('[INFO] Adjointe — cycle de triage déclenché');
    try {
      const rapport = await require('./adjointe/runner').executerCycle({});
      console.log('[INFO] Adjointe — examinés:', rapport.examines, 'retenus:', rapport.retenus,
        'escalades:', rapport.escalades, 'brouillons:', rapport.brouillons, 'envoyés:', rapport.envoyes);
      if (rapport.erreurs.length) console.log('[WARN] Adjointe — erreurs:', rapport.erreurs.join(' | '));
    } catch (e) {
      console.error('[ERROR] Adjointe — cycle échoué:', e.message);
    }
  });
}

app.listen(PORT, () => {
  console.log('[INFO] Bridge Avantage v7 démarré sur le port ' + PORT);
  console.log('[INFO] Export dir:', EXPORT_DIR);
  console.log('[INFO] Cron Avantage:', (CRON_SCHEDULE && CRON_SCHEDULE !== 'off') ? CRON_SCHEDULE : 'désactivé');
  console.log('[INFO] Adjointe IA — niveau', process.env.ADJOINTE_NIVEAU || '0',
    '| cron', process.env.ADJOINTE_CRON || 'désactivé',
    '| interface http://localhost:' + PORT + '/adjointe/');
});
