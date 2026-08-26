import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gl = require('../src/grandlivre/ecritures.js');
const bq = require('../src/banque/rapprochement.js');

const MIGRATIONS = path.join(import.meta.dirname, '..', 'db', 'migrations');
const U = 't.villeneuve@c-rc.ca';

async function baseNeuve() {
  const db = new PGlite();
  for (const f of fs.readdirSync(MIGRATIONS).sort()) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
  await db.transaction((tx) => gl.ouvrirExercice(tx, 2026));
  await db.query(
    `INSERT INTO banque.compte_bancaire (id, nom, institution, masque, compte_gl)
     VALUES (1, 'Opération — Desjardins', 'Desjardins', '4417', '11000')`
  );
  return db;
}

async function ajouterTransaction(db, { date, description, montant, marchand = null, enAttente = false }) {
  const r = await db.query(
    `INSERT INTO banque.transaction
       (compte_id, plaid_transaction_id, date_transaction, description, marchand, montant, en_attente)
     VALUES (1, $1, $2, $3, $4, $5, $6) RETURNING id`,
    [`plaid-${Math.random().toString(36).slice(2)}`, date, description, marchand, montant, enAttente]
  );
  return r.rows[0].id;
}

// ───────────────────────────────────────────────────────────────────────────
test('un décaissement débite la contrepartie et crédite la banque', async () => {
  const db = await baseNeuve();
  const id = await ajouterTransaction(db, {
    date: '2026-03-15', description: 'PAIEMENT PRO ARMATURE', montant: -1149.75,
  });

  await db.transaction((tx) =>
    bq.rapprocher(tx, id, { compteGl: '21000', tiersType: 'fournisseur', tiersId: 'PROARM' }, U)
  );

  const m = await db.query(
    `SELECT compte_numero, montant_debit, montant_credit FROM gl.mouvement ORDER BY rang`
  );
  assert.deepEqual(
    m.rows.map((x) => [x.compte_numero, Number(x.montant_debit), Number(x.montant_credit)]),
    [['21000', 1149.75, 0], ['11000', 0, 1149.75]]
  );
});

test('un encaissement débite la banque et crédite la contrepartie', async () => {
  const db = await baseNeuve();
  const id = await ajouterTransaction(db, {
    date: '2026-03-20', description: 'DEPOT MRC MEKINAC', montant: 45000.00,
  });

  await db.transaction((tx) =>
    bq.rapprocher(tx, id, { compteGl: '12000', tiersType: 'client', tiersId: 'MRC' }, U)
  );

  const m = await db.query(
    `SELECT compte_numero, montant_debit, montant_credit FROM gl.mouvement ORDER BY rang`
  );
  assert.deepEqual(
    m.rows.map((x) => [x.compte_numero, Number(x.montant_debit), Number(x.montant_credit)]),
    [['11000', 45000, 0], ['12000', 0, 45000]]
  );
});

test('le rapprochement lie la transaction à son écriture', async () => {
  const db = await baseNeuve();
  const id = await ajouterTransaction(db, { date: '2026-03-15', description: 'X', montant: -100 });
  const e = await db.transaction((tx) => bq.rapprocher(tx, id, { compteGl: '59000' }, U));

  const t = await db.query(`SELECT statut, ecriture_id, rapproche_par FROM banque.transaction WHERE id=$1`, [id]);
  assert.equal(t.rows[0].statut, 'rapprochee');
  assert.equal(Number(t.rows[0].ecriture_id), Number(e.id));
  assert.equal(t.rows[0].rapproche_par, U);
});

test('on ne rapproche pas deux fois la même transaction', async () => {
  const db = await baseNeuve();
  const id = await ajouterTransaction(db, { date: '2026-03-15', description: 'X', montant: -100 });
  await db.transaction((tx) => bq.rapprocher(tx, id, { compteGl: '59000' }, U));
  await assert.rejects(
    () => db.transaction((tx) => bq.rapprocher(tx, id, { compteGl: '59000' }, U)),
    /déjà rapprochée/
  );
});

test('une transaction encore en attente chez la banque est refusée', async () => {
  const db = await baseNeuve();
  const id = await ajouterTransaction(db, {
    date: '2026-03-15', description: 'PREAUTORISE', montant: -100, enAttente: true,
  });
  await assert.rejects(
    () => db.transaction((tx) => bq.rapprocher(tx, id, { compteGl: '59000' }, U)),
    /encore en attente/
  );
});

// ───────────────────────────────────────────────────────────────────────────
test('une règle sans critère n\'attrape rien', () => {
  assert.equal(bq.evaluerRegle({ compte_gl: '59000' }, { description: 'quoi que ce soit' }), null);
});

test('une règle plus spécifique obtient un meilleur score', () => {
  const t = { compte_id: 1, description: 'HYDRO QUEBEC', montant: -450 };
  const large = bq.evaluerRegle({ motif_description: 'HYDRO' }, t);
  const precise = bq.evaluerRegle(
    { motif_description: 'HYDRO QUEBEC', montant_min: -1000, montant_max: -100, compte_id: 1 }, t
  );
  assert.ok(precise > large);
});

test('une expression régulière invalide ne fait pas tomber la synchro', () => {
  assert.equal(bq.evaluerRegle({ motif_description: '[invalide(' }, { description: 'x' }), null);
});

test('les règles sont évaluées par ordre de priorité', () => {
  const t = { compte_id: 1, description: 'ESSENCE SHELL 1234', montant: -180 };
  const regles = [
    { id: 1, priorite: 10, motif_description: 'SHELL', compte_gl: '59100' },
    { id: 2, priorite: 50, motif_description: 'ESSENCE', compte_gl: '59000' },
  ];
  assert.equal(bq.trouverRegle(t, regles).regle.id, 1);
});

// ───────────────────────────────────────────────────────────────────────────
test('une règle automatique passe l\'écriture seule, une règle normale propose', async () => {
  const db = await baseNeuve();
  await db.query(
    `INSERT INTO banque.regle (nom, priorite, motif_description, compte_gl, automatique)
     VALUES ('Hydro-Québec', 10, 'HYDRO', '59000', true),
            ('Fournisseur inconnu', 90, 'PAIEMENT', '21000', false)`
  );

  await ajouterTransaction(db, { date: '2026-03-05', description: 'HYDRO QUEBEC PREAUT', montant: -812.44 });
  await ajouterTransaction(db, { date: '2026-03-06', description: 'PAIEMENT ACIER MAURICIE', montant: -5200.00 });
  await ajouterTransaction(db, { date: '2026-03-07', description: 'FRAIS INCONNUS XYZ', montant: -12.00 });

  const bilan = await db.transaction((tx) => bq.suggererEtAutomatiser(tx, 1, U));
  assert.deepEqual(bilan, { examinees: 3, suggerees: 1, automatiques: 1, sans_regle: 1 });

  const st = await db.query(
    `SELECT description, statut FROM banque.transaction ORDER BY date_transaction`
  );
  assert.deepEqual(st.rows.map((x) => x.statut), ['rapprochee', 'suggeree', 'a_traiter']);

  // Seule l'automatique a produit une écriture.
  const n = await db.query(`SELECT count(*)::int AS n FROM gl.ecriture WHERE journal_code='BQ'`);
  assert.equal(n.rows[0].n, 1);
});

test('une transaction ne peut pas être déclarée rapprochée sans écriture', async () => {
  const db = await baseNeuve();
  const id = await ajouterTransaction(db, { date: '2026-03-15', description: 'X', montant: -100 });
  await assert.rejects(
    () => db.query(`UPDATE banque.transaction SET statut='rapprochee' WHERE id=$1`, [id]),
    /transaction_statut_check|violates check/i
  );
});

test('le grand livre reste équilibré après rapprochements automatiques', async () => {
  const db = await baseNeuve();
  await db.query(
    `INSERT INTO banque.regle (nom, priorite, motif_description, compte_gl, automatique)
     VALUES ('Tout', 10, '.', '59000', true)`
  );
  for (let i = 1; i <= 6; i++) {
    await ajouterTransaction(db, {
      date: `2026-03-0${i}`, description: `MOUVEMENT ${i}`, montant: i % 2 ? -100 * i : 100 * i,
    });
  }
  await db.transaction((tx) => bq.suggererEtAutomatiser(tx, 1, U));

  const eq = await db.query(`SELECT ecart, equilibre FROM gl.controle_equilibre`);
  assert.equal(Number(eq.rows[0].ecart), 0);
  assert.equal(eq.rows[0].equilibre, true);
});
