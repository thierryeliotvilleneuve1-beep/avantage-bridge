const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const etatResultats = require('../services/etatResultats');
const source = require('../sources/donneesAvantage');
const cx = require('../db/connexion');
const { TABLES } = require('../config/colonnes-avantage');

// Toutes les routes de ce module sont en LECTURE SEULE : aucune n'écrit dans Avantage
// ni ailleurs. Elles répondent uniquement à des GET.

function validerDate(v, defaut) {
  const s = (v || '').toString().trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : defaut;
}

function ilYaDesMois(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

// Vue interactive — c'est l'écran à ouvrir dans le navigateur.
router.get('/vue', (req, res) => {
  const vue = path.join(__dirname, '../views/etat-resultats.html');
  if (!fs.existsSync(vue)) return res.status(500).send('Vue introuvable : ' + vue);
  res.type('html').send(fs.readFileSync(vue, 'utf8'));
});

// État des résultats complet, avec tout l'arbre de drill-down.
router.get('/', async (req, res) => {
  const debut = validerDate(req.query.debut, ilYaDesMois(12));
  const fin = validerDate(req.query.fin, new Date().toISOString().slice(0, 10));
  if (fin <= debut) return res.status(400).json({ erreur: 'La date de fin doit suivre la date de début.' });

  try {
    const etat = await etatResultats.construire(debut, fin);
    if (!etat.qualite.lignes_de_charge && !etat.revenus.nb_factures) {
      return res.json(Object.assign(etat, {
        erreur: 'Aucune donnée lue pour cette période. Vérifier le diagnostic : /api/etat-resultats/diagnostic',
      }));
    }
    res.json(etat);
  } catch (e) {
    console.error('[ERROR] etat-resultats:', e.message);
    res.status(500).json({ erreur: e.message });
  }
});

// Diagnostic : ce que le bridge voit, et d'où viendra chaque chiffre.
router.get('/diagnostic', (req, res) => {
  res.json({
    lecture_seule: true,
    ecrit_dans_avantage: false,
    sources: source.etatSources(),
  });
});

// Introspection de la base : liste les tables et leurs colonnes réelles.
// C'est la sortie à reporter dans src/config/colonnes-avantage.js pour passer
// de la lecture CSV à la lecture directe en base.
router.get('/diagnostic-bd', async (req, res) => {
  if (!cx.disponible()) {
    return res.json({
      disponible: false,
      raison: cx.raisonIndisponible(),
      marche_a_suivre: [
        '1. npm install odbc',
        '2. Dans .env : AVANTAGE_DSN=<nom du DSN ODBC>, AVANTAGE_BD_ACTIVE=true',
        '3. Relancer le bridge puis rappeler cette route.',
      ],
    });
  }

  try {
    const dialecte = await cx.dialecte();
    const tables = await cx.listerTables();
    const attendues = Object.keys(TABLES);
    const presentes = tables.filter(t => attendues.includes((t.nom || '').toUpperCase()));

    const colonnes = {};
    for (const t of presentes) {
      try { colonnes[t.nom] = await cx.listerColonnes(t.nom); }
      catch (e) { colonnes[t.nom] = { erreur: e.message }; }
    }

    res.json({
      disponible: true,
      lecture_seule: true,
      dialecte,
      nb_tables_visibles: tables.length,
      tables_avantage_trouvees: presentes.map(t => t.nom),
      tables_avantage_manquantes: attendues.filter(a => !presentes.some(p => (p.nom || '').toUpperCase() === a)),
      colonnes,
    });
  } catch (e) {
    res.status(500).json({ disponible: false, erreur: e.message });
  }
});

module.exports = router;
