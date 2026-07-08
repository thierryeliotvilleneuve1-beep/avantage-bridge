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

const { lireTable, SOURCE, DB_CONFIGUREE } = require('./datasources/avantage');

// Route status — publique
app.get('/api/status', (req, res) => {
  res.json({ ok: true, service: 'avantage-bridge', version: '8.0.0', source_donnees: SOURCE, db_configuree: DB_CONFIGUREE, export_dir: EXPORT_DIR });
});

// Diagnostic — aperçu d'une table Avantage (colonnes + premières lignes).
// Sert à valider le mapping des colonnes une fois la connexion DB en place :
//   GET /api/avantage/apercu/CONPRE?limit=5
app.get('/api/avantage/apercu/:table', auth, async (req, res) => {
  try {
    const t = await lireTable((req.params.table || '').toUpperCase());
    res.json({
      source: t.source, table: t.table, colonnes: t.colonnes,
      total_lignes: t.lignes.length,
      apercu: t.lignes.slice(0, Math.min(parseInt(req.query.limit, 10) || 5, 50)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  console.log('[INFO] Cron déclenché — refresh des données Avantage (source: ' + SOURCE + ')');
  try {
    const { parseContra } = require('./parsers/parseContra');
    const { parseFactma } = require('./parsers/parseFactma');
    const { writeProjets, writeFactures } = require('./writers/base44-writer');
    const contra = await lireTable('CONTRA');
    if (!contra.objets.length) {
      console.log('[WARN] CONTRA vide ou introuvable (source: ' + contra.source + ') — aucun projet chargé');
      return;
    }
    const projets = parseContra(contra.objets);
    console.log('[INFO] ' + projets.length + ' projets lus depuis CONTRA (' + contra.source + ')');
    const pResult = await writeProjets(projets);
    console.log('[INFO] Projets — créés:', pResult.created, 'mis à jour:', pResult.updated, 'erreurs:', pResult.errors);
    const factma = await lireTable('FACTMA');
    if (factma.objets.length) {
      const factures = parseFactma(factma.objets);
      console.log('[INFO] ' + factures.length + ' factures lues depuis FACTMA (' + factma.source + ')');
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
  console.log('[INFO] Bridge Avantage v8 démarré sur le port ' + PORT);
  console.log('[INFO] Source de données:', SOURCE + (SOURCE === 'db' ? ' (ODBC)' : ' (exports — configurer AVANTAGE_DSN pour lire la DB)'));
  if (SOURCE === 'csv') console.log('[INFO] Export dir:', EXPORT_DIR);
  console.log('[INFO] Cron:', CRON_SCHEDULE);
});
