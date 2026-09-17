require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const { runFullSync, syncState } = require('./services/fullSync');
const { choisir } = require('./sources');

const app = express();
app.use(cors());
app.use(express.json());

function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== cfg.API_KEY) return res.status(401).json({ error: 'Cle API manquante ou invalide' });
  next();
}

// Status — publique. Indique aussi la fraicheur des donnees pousees dans Manoeuvre.
app.get('/api/status', (req, res) => {
  const st = syncState();
  res.json({
    ok: true,
    service: 'avantage-bridge',
    version: cfg.VERSION,
    source: choisir(),
    export_dir: cfg.EXPORT_DIR,
    cron: cfg.CRON_SCHEDULE,
    sync_complet_au_cron: cfg.FULL_SYNC_ON_CRON,
    projets_cibles: cfg.SYNC_PROJETS,
    donnees_a_jour: st.donnees_a_jour,
    sync: st,
  });
});

app.use('/api/sync', auth, require('./routes/sync'));
app.use('/api/budget', auth, require('./routes/budget'));
app.use('/api/bc', auth, require('./routes/bc-sync'));
app.use('/api/trans', auth, require('./routes/trans-sync'));

// Cron — sync complet (et non plus seulement projets + factures).
cron.schedule(cfg.CRON_SCHEDULE, async () => {
  console.log('[INFO] Cron declenche —', new Date().toISOString());
  const r = await runFullSync({ full: cfg.FULL_SYNC_ON_CRON });
  if (r.skipped) console.log('[INFO] Cron ignore —', r.reason);
  else console.log('[INFO] Cron termine en ' + r.duree_s + 's — projets:', r.projets_cibles, 'erreurs:', r.erreurs);
});

// Surveillance de export.xlsx — un nouvel export Avantage declenche un sync
// sans attendre le prochain passage du cron.
if (cfg.WATCH_EXPORT && choisir() === 'xlsx' && fs.existsSync(cfg.EXPORT_DIR)) {
  let timer = null;
  try {
    fs.watch(cfg.EXPORT_DIR, (evt, filename) => {
      if (!filename || path.basename(filename).toLowerCase() !== 'export.xlsx') return;
      clearTimeout(timer);
      // Debounce: l'ecriture du fichier par Avantage/Excel genere plusieurs evenements.
      timer = setTimeout(async () => {
        console.log('[INFO] Nouvel export.xlsx detecte — sync declenche');
        const r = await runFullSync({ forceConvert: true });
        if (r.skipped) console.log('[INFO] Sync ignore —', r.reason);
        else console.log('[INFO] Sync sur export termine en ' + r.duree_s + 's');
      }, 60000);
    });
    console.log('[INFO] Surveillance active sur', cfg.XLSX_PATH);
  } catch (e) {
    console.error('[WARN] Surveillance impossible:', e.message);
  }
}

app.listen(cfg.PORT, () => {
  console.log('[INFO] Bridge Avantage v' + cfg.VERSION + ' demarre sur le port ' + cfg.PORT);
  console.log('[INFO] Source Avantage:', choisir() === 'odbc' ? 'BD directe (ODBC)' : 'export.xlsx');
  console.log('[INFO] Export dir:', cfg.EXPORT_DIR);
  console.log('[INFO] Cron:', cfg.CRON_SCHEDULE, '| sync complet:', cfg.FULL_SYNC_ON_CRON, '| projets:', cfg.SYNC_PROJETS);
});
