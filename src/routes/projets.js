const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { parseContra } = require('../parsers/parseContra');
const { parseFactma } = require('../parsers/parseFactma');

const EXPORT_DIR = path.resolve(__dirname, '../../exports-avantage');

// Normalise pour comparaison: minuscules, sans accents, tirets/espaces unifiés
function normalize(s) {
  return (s || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Numéro de projet sans zéros de tête pour apparier CONTRA (CONUM) et FACTMA (FFCONT)
function projKey(num) {
  const n = (num || '').toString().trim().replace(/^0+/, '');
  return n || (num || '').toString().trim();
}

// GET /api/projets?client=trois rivieres
// Liste les projets de CONTRA.csv, filtrés par nom de client ou nom de projet,
// avec les montants facturés agrégés depuis FACTMA.csv
router.get('/', (req, res) => {
  const contraPath = path.join(EXPORT_DIR, 'CONTRA.csv');
  if (!fs.existsSync(contraPath)) {
    return res.status(404).json({ error: 'CONTRA.csv introuvable dans ' + EXPORT_DIR });
  }

  const projets = parseContra(fs.readFileSync(contraPath, 'latin1'));

  // Agrégation des factures par projet
  const factures = {};
  const clientsFactures = {};
  const factmaPath = path.join(EXPORT_DIR, 'FACTMA.csv');
  if (fs.existsSync(factmaPath)) {
    for (const f of parseFactma(fs.readFileSync(factmaPath, 'latin1'))) {
      const k = projKey(f.numero_projet);
      if (!k) continue;
      if (!factures[k]) factures[k] = { total_facture: 0, solde_ouvert: 0, retenue_total: 0, nb_factures: 0 };
      factures[k].total_facture += f.total_facture;
      factures[k].solde_ouvert += f.solde_ouvert;
      factures[k].retenue_total += f.retenue_total;
      factures[k].nb_factures += 1;
      if (f.client_nom && !clientsFactures[k]) clientsFactures[k] = f.client_nom;
    }
  }

  // Chaque mot du filtre doit apparaître dans le client ou le nom du projet
  // (ex.: "omh trois-rivieres" trouve "OMH de Trois-Rivières")
  const motsFiltre = normalize(req.query.client || '').split(' ').filter(Boolean);
  const matchFiltre = p => {
    if (!motsFiltre.length) return true;
    const cible = normalize(p.client_nom) + ' ' + normalize(p.nom_projet);
    return motsFiltre.every(m => cible.includes(m));
  };
  const rows = projets
    .map(p => {
      const k = projKey(p.numero_projet);
      const fact = factures[k] || { total_facture: 0, solde_ouvert: 0, retenue_total: 0, nb_factures: 0 };
      return {
        numero_projet: p.numero_projet,
        nom_projet: p.nom_projet,
        client_nom: p.client_nom || clientsFactures[k] || '',
        statut: p.statut,
        date_debut: p.date_debut,
        date_fin_prevue: p.date_fin_prevue,
        budget_prevu: Math.round(p.budget_prevu * 100) / 100,
        cout_reel: Math.round(p.cout_reel * 100) / 100,
        total_facture: Math.round(fact.total_facture * 100) / 100,
        solde_ouvert: Math.round(fact.solde_ouvert * 100) / 100,
        retenue_total: Math.round(fact.retenue_total * 100) / 100,
        nb_factures: fact.nb_factures,
      };
    })
    .filter(matchFiltre);

  const totaux = rows.reduce((t, p) => {
    t.budget_prevu += p.budget_prevu;
    t.cout_reel += p.cout_reel;
    t.total_facture += p.total_facture;
    t.solde_ouvert += p.solde_ouvert;
    t.retenue_total += p.retenue_total;
    return t;
  }, { budget_prevu: 0, cout_reel: 0, total_facture: 0, solde_ouvert: 0, retenue_total: 0 });
  for (const k of Object.keys(totaux)) totaux[k] = Math.round(totaux[k] * 100) / 100;

  res.json({
    filtre_client: req.query.client || null,
    count: rows.length,
    totaux,
    projets: rows,
  });
});

module.exports = router;
