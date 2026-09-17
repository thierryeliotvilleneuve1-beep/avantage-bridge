const express = require('express');
const router = express.Router();
const { runFullSync, syncState } = require('../services/fullSync');
const { convertXlsx } = require('../services/convert');
const { choisir } = require('../sources');

// Sync complet: conversion + projets + factures + budget/BC/transactions de tous
// les projets actifs. Repond quand tout est termine.
router.post('/all', async (req, res) => {
  const codes = req.query.projets ? req.query.projets.split(',') : null;
  const force = req.query.force === '1';
  const r = await runFullSync({ codes, force, forceConvert: force });
  res.status(r.ok === false && !r.skipped ? 500 : 200).json(r);
});

// Sync complet d'un seul projet (budget + BC + transactions).
router.post('/projet/:code', async (req, res) => {
  const force = req.query.force === '1';
  const r = await runFullSync({ codes: [req.params.code], force, forceConvert: force });
  res.status(r.ok === false && !r.skipped ? 500 : 200).json(r);
});

// Conversion export.xlsx -> CSV seulement.
router.post('/convert', (req, res) => {
  try {
    res.json(convertXlsx(req.query.force !== '0'));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/state', (req, res) => res.json(syncState()));

// Diagnostic de la source: connexion BD, tables, colonnes resolues.
router.get('/source', async (req, res) => {
  const nom = choisir();
  if (nom !== 'odbc') return res.json({ source: 'xlsx', raison: 'aucune connexion ODBC configuree' });
  try {
    const { inspecter } = require('../services/dbInspect');
    res.json(await inspecter());
  } catch (e) {
    res.status(500).json({ source: 'odbc', ok: false, error: e.message });
  }
});

module.exports = router;
