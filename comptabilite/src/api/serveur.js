'use strict';

const express = require('express');
const path = require('path');
const gl = require('../grandlivre/ecritures');
const bq = require('../banque/rapprochement');

/**
 * API du système comptable.
 *
 * Toute écriture passe par le moteur, jamais par du SQL direct depuis une
 * route : c'est le moteur qui connaît l'ordre brouillon → lignes → validation
 * que les triggers imposent.
 */
function creerServeur(db, { utilisateurParDefaut = 'demo@c-rc.ca' } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  const utilisateur = (req) => req.header('x-utilisateur') || utilisateurParDefaut;

  // Renvoie une erreur métier lisible plutôt qu'une trace Postgres brute.
  const route = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      const message = String(e.message || e).replace(/^error:\s*/i, '');
      console.error('[api]', req.method, req.path, '—', message);
      res.status(400).json({ erreur: message });
    }
  };

  // ── État général ──────────────────────────────────────────────────────
  app.get('/api/etat', route(async (req, res) => {
    const eq = await db.query(`SELECT * FROM gl.controle_equilibre`);
    const att = await db.query(
      `SELECT count(*)::int AS n FROM banque.transaction WHERE statut IN ('a_traiter','suggeree')`
    );
    const ecr = await db.query(
      `SELECT count(*)::int AS n FROM gl.ecriture WHERE statut <> 'brouillon'`
    );
    const per = await db.query(
      `SELECT p.numero, p.date_debut, p.date_fin, p.statut
         FROM gl.periode p JOIN gl.exercice e ON e.id = p.exercice_id
        WHERE e.statut='ouvert' AND p.statut='ouverte' ORDER BY p.numero`
    );
    res.json({
      mode: db.mode,
      equilibre: eq.rows[0] ? eq.rows[0].equilibre : true,
      ecart: eq.rows[0] ? Number(eq.rows[0].ecart) : 0,
      transactions_en_attente: att.rows[0].n,
      ecritures: ecr.rows[0].n,
      periodes_ouvertes: per.rows.length,
    });
  }));

  // ── Plan comptable ────────────────────────────────────────────────────
  app.get('/api/comptes', route(async (req, res) => {
    const r = await db.query(
      `SELECT numero, nom, type, sens_normal FROM gl.compte
        WHERE actif AND accepte_ecriture ORDER BY numero`
    );
    res.json(r.rows);
  }));

  // ── Banque ────────────────────────────────────────────────────────────
  app.get('/api/banque/a-traiter', route(async (req, res) => {
    const r = await db.query(`SELECT * FROM banque.a_traiter`);
    res.json(r.rows.map((x) => ({ ...x, montant: Number(x.montant) })));
  }));

  app.get('/api/banque/comptes', route(async (req, res) => {
    const r = await db.query(
      `SELECT id, nom, institution, masque, compte_gl, plaid_derniere_sync
         FROM banque.compte_bancaire WHERE actif ORDER BY nom`
    );
    res.json(r.rows);
  }));

  app.post('/api/banque/:id/rapprocher', route(async (req, res) => {
    const { compteGl, projet, activite, tiersType, tiersId } = req.body || {};
    if (!compteGl) throw new Error('Choisissez un compte d\'imputation');
    const ecriture = await db.transaction((tx) =>
      bq.rapprocher(tx, Number(req.params.id),
        { compteGl, projet, activite, tiersType, tiersId }, utilisateur(req))
    );
    res.json({ ok: true, ecriture });
  }));

  app.post('/api/banque/:id/ignorer', route(async (req, res) => {
    const r = await db.query(
      `UPDATE banque.transaction SET statut='ignoree'
        WHERE id=$1 AND statut <> 'rapprochee' RETURNING id`,
      [Number(req.params.id)]
    );
    if (!r.rows.length) throw new Error('Transaction déjà rapprochée : elle ne peut plus être ignorée');
    res.json({ ok: true });
  }));

  app.post('/api/banque/:compteId/suggerer', route(async (req, res) => {
    const bilan = await db.transaction((tx) =>
      bq.suggererEtAutomatiser(tx, Number(req.params.compteId), utilisateur(req))
    );
    res.json(bilan);
  }));

  // ── Grand livre ───────────────────────────────────────────────────────
  app.get('/api/gl/balance', route(async (req, res) => {
    const r = await db.query(
      `SELECT compte_numero, compte_nom, compte_type, total_debit, total_credit,
              solde_sens_normal
         FROM gl.balance_verification ORDER BY compte_numero`
    );
    res.json(r.rows.map((x) => ({
      ...x,
      total_debit: Number(x.total_debit),
      total_credit: Number(x.total_credit),
      solde_sens_normal: Number(x.solde_sens_normal),
    })));
  }));

  app.get('/api/gl/ecritures', route(async (req, res) => {
    const r = await db.query(
      `SELECT e.id, e.numero_piece, e.journal_code, e.date_ecriture, e.libelle,
              e.statut, e.source_type,
              (SELECT sum(montant_debit) FROM gl.ligne_ecriture WHERE ecriture_id = e.id) AS total
         FROM gl.ecriture e WHERE e.statut <> 'brouillon'
        ORDER BY e.date_ecriture DESC, e.id DESC LIMIT 100`
    );
    res.json(r.rows.map((x) => ({ ...x, total: Number(x.total) })));
  }));

  app.get('/api/gl/ecritures/:id', route(async (req, res) => {
    const l = await db.query(
      `SELECT rang, compte_numero, compte_nom, libelle_ligne,
              montant_debit, montant_credit, code_projet, code_activite
         FROM gl.mouvement WHERE ecriture_id=$1 ORDER BY rang`,
      [Number(req.params.id)]
    );
    res.json(l.rows.map((x) => ({
      ...x, montant_debit: Number(x.montant_debit), montant_credit: Number(x.montant_credit),
    })));
  }));

  // ── Coût par projet — ce que Manœuvre relira ──────────────────────────
  app.get('/api/projets/:code/cout', route(async (req, res) => {
    const r = await db.query(
      `SELECT code_activite, sum(montant) AS montant
         FROM gl.cout_projet
        WHERE code_projet=$1 AND compte_type='charges'
        GROUP BY code_activite ORDER BY code_activite`,
      [req.params.code]
    );
    res.json(r.rows.map((x) => ({ ...x, montant: Number(x.montant) })));
  }));

  return app;
}

module.exports = { creerServeur };
