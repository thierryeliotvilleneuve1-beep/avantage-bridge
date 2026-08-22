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
// Une seule definition du repertoire d'export, partagee avec les parseurs.
const { EXPORT_DIR } = require('./lib/sources');
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/15 * * * *';

// Auth middleware
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Clé API manquante ou invalide' });
  next();
}

// Fichiers d'export attendus depuis Avantage, et ce qu'ils alimentent.
const SOURCES_ATTENDUES = [
  ['CONTRA.csv',  'projets'],
  ['FACTMA.csv',  'factures client'],
  ['CONPRE.csv',  'budget de couts par activite'],
  ['CONFIT.csv',  'budget de revenus par activite (marge)'],
  ['CONACT.csv',  'facture et depense a venir par activite'],
  ['TRANS.csv',   'couts reels'],
  ['COMITE.csv',  'rattachement commande -> activite'],
  ['PYBBIL.csv',  'factures fournisseurs'],
  ['ACTIVE.csv',  'libelles d activite'],
  ['export.xlsx', 'bons de commande (feuille COMMAN)'],
];

// Route status — publique. Expose la fraicheur des exports : un chiffre de
// marge ne vaut que par la date de l'export qui l'alimente.
app.get('/api/status', (req, res) => {
  const sources = SOURCES_ATTENDUES.map(([fichier, alimente]) => {
    const p = path.join(EXPORT_DIR, fichier);
    let present = false, maj = null, taille = null;
    try {
      const st = fs.statSync(p);
      present = true;
      maj = st.mtime.toISOString();
      taille = st.size;
    } catch (e) { /* fichier absent */ }
    return { fichier, alimente, present, maj, taille };
  });
  const manquants = sources.filter((s) => !s.present).map((s) => s.fichier);
  res.json({
    ok: true,
    service: 'avantage-bridge',
    version: '7.1.0',
    export_dir: EXPORT_DIR,
    derniere_sync_cron: lastSync,
    marge_calculable: sources.find((s) => s.fichier === 'CONFIT.csv').present,
    sources,
    manquants: manquants.length ? manquants : undefined,
  });
});

// Etat de la derniere execution du cron, expose par /api/status.
let lastSync = null;

// Routes — protégées
const budgetRouter = require('./routes/budget');
const bcSyncRouter = require('./routes/bc-sync');
const transSyncRouter = require('./routes/trans-sync');
const margeRouter = require('./routes/marge');

app.use('/api/budget', auth, budgetRouter);
app.use('/api/bc', auth, bcSyncRouter);
app.use('/api/trans', auth, transSyncRouter);
app.use('/api/marge', auth, margeRouter);

// Cron sync
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
  console.log('[INFO] Bridge Avantage v7.1 démarré sur le port ' + PORT);
  console.log('[INFO] Export dir:', EXPORT_DIR);
  console.log('[INFO] Cron:', CRON_SCHEDULE);
});
