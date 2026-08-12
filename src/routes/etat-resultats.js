const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const etatResultats = require('../services/etatResultats');
const source = require('../sources/donneesAvantage');
const cx = require('../db/connexion');
const autoMappage = require('../db/autoMappage');
const { TABLES, estLisibleEnBd } = require('../config/colonnes-avantage');

// Toutes les routes de ce module sont en LECTURE SEULE : aucune n'écrit dans Avantage
// ni ailleurs. Elles ne répondent qu'aux GET.

function validerDate(v, defaut) {
  const s = (v || '').toString().trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : defaut;
}

function ilYaDesMois(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

// Vue interactive — l'écran à ouvrir dans le navigateur.
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
    voie_acces_bd: cx.voie(),
    sources: source.etatSources(),
  });
});

// Introspection de la base : tables et colonnes réellement présentes.
router.get('/diagnostic-bd', async (req, res) => {
  if (!cx.disponible()) {
    return res.json({
      disponible: false,
      raison: cx.raisonIndisponible(),
      marche_a_suivre: [
        'Dans .env : AVANTAGE_DSN=<nom du DSN ODBC> et AVANTAGE_BD_ACTIVE=true',
        'Relancer le bridge, puis rappeler cette route.',
        'Aucune installation n\'est requise : sous Windows, le bridge passe par PowerShell.',
      ],
    });
  }

  try {
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
      voie: cx.voie(),
      nb_tables_visibles: tables.length,
      tables_avantage_trouvees: presentes.map(t => t.nom),
      tables_avantage_manquantes: attendues.filter(a => !presentes.some(p => (p.nom || '').toUpperCase() === a)),
      colonnes,
    });
  } catch (e) {
    res.status(500).json({ disponible: false, erreur: e.message });
  }
});

// Auto-mappage : déduit les colonnes par position et les valide sur les données réelles.
// C'est ce qui remplace la transcription manuelle des noms de colonnes.
router.get('/mappage', async (req, res) => {
  if (!cx.disponible()) {
    return res.json({ disponible: false, raison: cx.raisonIndisponible() });
  }
  try {
    const resultats = await source.autoMapper(true);
    const retenues = resultats.filter(r => r.retenu).map(r => r.table);
    const refusees = resultats.filter(r => !r.retenu);
    res.json({
      disponible: true,
      voie: cx.voie(),
      lecture_seule: true,
      tables_lues_en_bd: Object.keys(TABLES).filter(t => estLisibleEnBd(t)),
      deduites_et_validees: retenues,
      non_retenues: refusees.map(r => ({ table: r.table, raison: r.raison, controles: r.controles })),
      detail: resultats,
      note: retenues.length
        ? 'Ces tables sont désormais lues directement dans la base. Les autres continuent de '
          + 'passer par leur export CSV, sans perte de fonctionnalité.'
        : 'Aucune table n\'a pu être déduite avec certitude. Le bridge lit les exports CSV. '
          + 'Voir /api/etat-resultats/diagnostic-bd pour les noms de colonnes réels.',
    });
  } catch (e) {
    res.status(500).json({ disponible: false, erreur: e.message });
  }
});

module.exports = router;
