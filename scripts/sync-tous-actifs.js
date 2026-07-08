// Synchronise TOUS les projets actifs depuis la base Avantage, en une commande.
//
//   node scripts/sync-tous-actifs.js                  (budget + transactions)
//   node scripts/sync-tous-actifs.js --avec-bc        (ajoute les bons de commande)
//   node scripts/sync-tous-actifs.js --budget-seulement
//
// À exécuter sur la machine du bridge, avec le bridge démarré (npm start) et
// AVANTAGE_DSN configuré dans .env (lecture directe de la DB Avantage).
// Grâce aux correctifs anti-doublon, ce sync est un miroir : réexécutable
// sans risque, il met à jour, dédoublonne et supprime les divisions retirées.

require('dotenv').config();
const https = require('https');
const http = require('http');

const AVEC_BC = process.argv.includes('--avec-bc');
const BUDGET_SEULEMENT = process.argv.includes('--budget-seulement');

const BASE44_KEY = process.env.BASE44_API_KEY;
const APP_ID = process.env.BASE44_APP_ID || '68927e133cde9f63295dd616';
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

function apiBase44(p) {
  return new Promise((res) => {
    const r = https.request({
      hostname: 'app.base44.com', path: '/api/apps/' + APP_ID + p, method: 'GET',
      headers: { 'api_key': BASE44_KEY },
    }, re => {
      let d = '';
      re.on('data', c => d += c);
      re.on('end', () => res({ status: re.statusCode, data: d }));
    });
    r.on('error', e => res({ status: 0, data: JSON.stringify({ error: e.message }) }));
    r.end();
  });
}

function bridge(pathBridge) {
  return new Promise((res) => {
    const r = http.request({
      hostname: 'localhost', port: PORT, path: pathBridge, method: 'POST',
      headers: { 'x-api-key': API_KEY },
    }, re => {
      let d = '';
      re.on('data', c => d += c);
      re.on('end', () => res({ status: re.statusCode, data: d }));
    });
    r.on('error', e => res({ status: 0, data: e.message }));
    r.end();
  });
}

function normaliser(c) {
  return String(c || '').toUpperCase().trim().replace(/^P/, '').replace(/^0+/, '');
}

(async () => {
  if (!BASE44_KEY) { console.error('BASE44_API_KEY manquante (.env)'); process.exit(1); }
  if (!API_KEY) { console.error('API_KEY manquante (.env)'); process.exit(1); }

  const santeBridge = await bridge('/api/budget/sync/__test__').catch(() => ({ status: 0 }));
  if (santeBridge.status === 0) {
    console.error('Bridge injoignable sur localhost:' + PORT + ' — démarrer le bridge (npm start) puis relancer.');
    process.exit(1);
  }

  const pRes = await apiBase44('/entities/Projet?limit=500');
  let projets = [];
  try { const d = JSON.parse(pRes.data); projets = Array.isArray(d) ? d : (d.items || []); } catch (e) {}
  const actifs = projets
    .filter(p => (p.statut || '') === 'actif' && normaliser(p.code_projet))
    .sort((a, b) => String(a.code_projet).localeCompare(String(b.code_projet)));
  if (!actifs.length) { console.error('Aucun projet actif trouvé dans Base44.'); process.exit(1); }
  console.log(actifs.length + ' projets actifs à synchroniser.\n');

  const bilan = [];
  for (const p of actifs) {
    const code = normaliser(p.code_projet);
    const ligne = { projet: p.code_projet, nom: p.nom || '' };
    process.stdout.write(p.code_projet + ' (' + (p.nom || '') + ')\n');

    const b = await bridge('/api/budget/sync/' + code);
    ligne.budget = resumer(b);
    console.log('  budget : ' + ligne.budget);

    if (!BUDGET_SEULEMENT) {
      const t = await bridge('/api/trans/sync-trans/' + code);
      ligne.transactions = resumer(t);
      console.log('  trans  : ' + ligne.transactions);
    }
    if (AVEC_BC) {
      const bc = await bridge('/api/bc/sync-bc/' + code);
      ligne.bons_commande = resumer(bc);
      console.log('  bc     : ' + ligne.bons_commande);
    }
    bilan.push(ligne);
  }

  console.log('\n=== BILAN ===');
  const problemes = bilan.filter(l => /erreur|error|non trouve/i.test(JSON.stringify(l)));
  console.log(bilan.length + ' projets traités, ' + problemes.length + ' avec anomalies.');
  problemes.forEach(l => console.log('  À vérifier : ' + l.projet + ' → ' + JSON.stringify(l)));
})();

function resumer(r) {
  try {
    const d = JSON.parse(r.data);
    if (d.error) return 'ERREUR: ' + d.error;
    const morceaux = [];
    if (d.phases !== undefined) morceaux.push(d.phases + ' divisions');
    if (d.total !== undefined) morceaux.push(d.total + ' transactions');
    if (d.bcs !== undefined) morceaux.push(d.bcs + ' BC');
    if (d.created) morceaux.push(d.created + ' créées');
    if (d.updated) morceaux.push(d.updated + ' à jour');
    if (d.deleted_doublons) morceaux.push(d.deleted_doublons + ' doublons suppr.');
    if (d.deleted_orphelins) morceaux.push(d.deleted_orphelins + ' orphelines suppr.');
    if (d.errors) morceaux.push(d.errors + ' ERREURS');
    return morceaux.join(', ') || r.data.slice(0, 120);
  } catch (e) {
    return 'HTTP ' + r.status + ' — ' + String(r.data).slice(0, 120);
  }
}
