import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gl = require('../src/grandlivre/ecritures.js');

const MIGRATIONS = path.join(import.meta.dirname, '..', 'db', 'migrations');

async function baseNeuve() {
  const db = new PGlite();
  for (const f of fs.readdirSync(MIGRATIONS).sort()) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
  await db.transaction((tx) => gl.ouvrirExercice(tx, 2026));
  return db;
}

const U = 't.villeneuve@c-rc.ca';

/** Écriture d'achat équilibrée : 1 000 $ de travaux + taxes, dû au fournisseur. */
const achatType = (date = '2026-03-15', sourceId = null) => ({
  exercice: 2026, journal: 'ACH', date, utilisateur: U,
  libelle: 'Facture Pro Armature 060449',
  sourceType: sourceId ? 'facture_fournisseur' : 'manuelle',
  sourceId,
  lignes: [
    { compte: '33200', debit: 1000.00, projet: '23020', activite: '03530', libelle: 'Armature' },
    { compte: '21340', debit: 50.00, taxe: 'TPS_CTI' },
    { compte: '21370', debit: 99.75, taxe: 'TVQ_RTI' },
    { compte: '21000', credit: 1149.75, tiersType: 'fournisseur', tiersId: 'PROARM' },
  ],
});

// ───────────────────────────────────────────────────────────────────────────
test('une écriture équilibrée se passe et apparaît dans la balance', async () => {
  const db = await baseNeuve();
  const r = await db.transaction((tx) => gl.passer(tx, achatType()));

  assert.equal(r.numeroPiece, 'ACH-2026-000001');

  const bal = await db.query(
    `SELECT compte_numero, total_debit, total_credit FROM gl.balance_verification
      ORDER BY compte_numero`
  );
  assert.deepEqual(
    bal.rows.map((x) => [x.compte_numero, Number(x.total_debit), Number(x.total_credit)]),
    [['21000', 0, 1149.75], ['21340', 50, 0], ['21370', 99.75, 0], ['33200', 1000, 0]]
  );

  const eq = await db.query(`SELECT ecart, equilibre FROM gl.controle_equilibre`);
  assert.equal(Number(eq.rows[0].ecart), 0);
  assert.equal(eq.rows[0].equilibre, true);
});

test('une écriture déséquilibrée est refusée au COMMIT', async () => {
  const db = await baseNeuve();
  const bancale = achatType();
  bancale.lignes[3].credit = 1149.74; // un cent manquant

  await assert.rejects(
    () => db.transaction((tx) => gl.passer(tx, bancale)),
    /déséquilibrée.*écart/s
  );

  // Rien ne doit subsister : la transaction entière a été annulée.
  const n = await db.query(`SELECT count(*)::int AS n FROM gl.ecriture`);
  assert.equal(n.rows[0].n, 0);
});

test('une écriture à une seule ligne est refusée', async () => {
  const db = await baseNeuve();
  await assert.rejects(
    () => db.transaction((tx) => gl.passer(tx, {
      ...achatType(), lignes: [{ compte: '33200', debit: 100 }],
    })),
    /au moins deux lignes/
  );
});

// ───────────────────────────────────────────────────────────────────────────
test('une écriture validée ne peut plus être modifiée', async () => {
  const db = await baseNeuve();
  const { id } = await db.transaction((tx) => gl.passer(tx, achatType()));

  await assert.rejects(
    () => db.query(`UPDATE gl.ecriture SET libelle='trafiqué' WHERE id=$1`, [id]),
    /immuable/
  );
  await assert.rejects(
    () => db.query(`UPDATE gl.ecriture SET date_ecriture='2026-01-01' WHERE id=$1`, [id]),
    /immuable/
  );
});

test('une écriture validée ne peut pas être supprimée', async () => {
  const db = await baseNeuve();
  const { id } = await db.transaction((tx) => gl.passer(tx, achatType()));
  await assert.rejects(
    () => db.query(`DELETE FROM gl.ecriture WHERE id=$1`, [id]),
    /ne peut pas être supprimée/
  );
});

test('les lignes d\'une écriture validée sont figées', async () => {
  const db = await baseNeuve();
  const { id } = await db.transaction((tx) => gl.passer(tx, achatType()));

  await assert.rejects(
    () => db.query(`UPDATE gl.ligne_ecriture SET montant_debit=9999 WHERE ecriture_id=$1`, [id]),
    /immuables/
  );
  await assert.rejects(
    () => db.query(`DELETE FROM gl.ligne_ecriture WHERE ecriture_id=$1`, [id]),
    /immuables/
  );
  await assert.rejects(
    () => db.query(
      `INSERT INTO gl.ligne_ecriture (ecriture_id,rang,compte_numero,montant_debit)
       VALUES ($1,99,'59000',1)`, [id]),
    /immuables/
  );
});

// ───────────────────────────────────────────────────────────────────────────
test('la contrepassation annule sans effacer', async () => {
  const db = await baseNeuve();
  const { id } = await db.transaction((tx) => gl.passer(tx, achatType()));

  const contre = await db.transaction((tx) =>
    gl.contrepasser(tx, id, { date: '2026-04-02', motif: 'facture en double', utilisateur: U })
  );
  assert.equal(contre.numeroPiece, 'ACH-2026-000002');

  // L'originale demeure, marquée contrepassée et pointant vers son annulation.
  const o = await db.query(`SELECT statut, contrepassee_par_id FROM gl.ecriture WHERE id=$1`, [id]);
  assert.equal(o.rows[0].statut, 'contrepassee');
  assert.equal(Number(o.rows[0].contrepassee_par_id), Number(contre.id));

  // Les deux écritures figurent aux livres et leur somme est nulle.
  const bal = await db.query(
    `SELECT sum(solde_debiteur) AS s FROM gl.balance_verification`
  );
  assert.equal(Number(bal.rows[0].s), 0);

  const lignes = await db.query(`SELECT count(*)::int AS n FROM gl.mouvement`);
  assert.equal(lignes.rows[0].n, 8, 'les 4 lignes originales et les 4 lignes miroir sont conservées');
});

test('on ne contrepasse pas deux fois', async () => {
  const db = await baseNeuve();
  const { id } = await db.transaction((tx) => gl.passer(tx, achatType()));
  await db.transaction((tx) => gl.contrepasser(tx, id, { motif: 'x', utilisateur: U, date: '2026-04-02' }));
  await assert.rejects(
    () => db.transaction((tx) => gl.contrepasser(tx, id, { motif: 'y', utilisateur: U, date: '2026-04-03' })),
    /déjà contrepassée/
  );
});

// ───────────────────────────────────────────────────────────────────────────
test('une période fermée refuse toute écriture', async () => {
  const db = await baseNeuve();
  await db.query(`UPDATE gl.periode SET statut='fermee' WHERE exercice_id=2026 AND numero=3`);
  await assert.rejects(
    () => db.transaction((tx) => gl.passer(tx, achatType('2026-03-15'))),
    /est fermée/
  );
});

test('un exercice fermé refuse toute écriture', async () => {
  const db = await baseNeuve();
  await db.query(`UPDATE gl.exercice SET statut='ferme' WHERE id=2026`);
  await assert.rejects(
    () => db.transaction((tx) => gl.passer(tx, achatType())),
    /est fermé/
  );
});

test('une période ne se ferme pas sur un brouillon oublié', async () => {
  const db = await baseNeuve();
  const p = await db.query(`SELECT id FROM gl.periode WHERE exercice_id=2026 AND numero=3`);
  await db.query(
    `INSERT INTO gl.ecriture (exercice_id,periode_id,journal_code,numero_piece,
       date_ecriture,libelle,statut,cree_par)
     VALUES (2026,$1,'OD','OD-2026-999999','2026-03-10','oubli','brouillon',$2)`,
    [p.rows[0].id, U]
  );
  await assert.rejects(
    () => db.query(`UPDATE gl.periode SET statut='fermee' WHERE id=$1`, [p.rows[0].id]),
    /écriture\(s\) au brouillon/
  );
});

test('une date hors de sa période est refusée', async () => {
  const db = await baseNeuve();
  const p = await db.query(`SELECT id FROM gl.periode WHERE exercice_id=2026 AND numero=3`);
  await assert.rejects(
    () => db.query(
      `INSERT INTO gl.ecriture (exercice_id,periode_id,journal_code,numero_piece,
         date_ecriture,libelle,statut,cree_par)
       VALUES (2026,$1,'OD','OD-2026-888888','2026-07-10','mauvaise période','brouillon',$2)`,
      [p.rows[0].id, U]),
    /hors de la période déclarée/
  );
});

// ───────────────────────────────────────────────────────────────────────────
test('un compte de regroupement refuse les écritures', async () => {
  const db = await baseNeuve();
  await assert.rejects(
    () => db.transaction((tx) => gl.passer(tx, {
      ...achatType(),
      lignes: [{ compte: '5000', debit: 100 }, { compte: '21000', credit: 100 }],
    })),
    /compte de regroupement/
  );
});

test('la numérotation des pièces est séquentielle et sans trou', async () => {
  const db = await baseNeuve();
  for (let i = 0; i < 5; i++) {
    await db.transaction((tx) => gl.passer(tx, achatType('2026-03-1' + i)));
  }
  const r = await db.query(
    `SELECT numero_piece FROM gl.ecriture WHERE journal_code='ACH' ORDER BY numero_piece`
  );
  assert.deepEqual(r.rows.map((x) => x.numero_piece), [
    'ACH-2026-000001', 'ACH-2026-000002', 'ACH-2026-000003',
    'ACH-2026-000004', 'ACH-2026-000005',
  ]);
});

test('chaque journal a sa propre séquence', async () => {
  const db = await baseNeuve();
  await db.transaction((tx) => gl.passer(tx, achatType()));
  const vente = await db.transaction((tx) => gl.passer(tx, {
    exercice: 2026, journal: 'VTE', date: '2026-03-20', utilisateur: U,
    libelle: 'Facture progressive P23020',
    lignes: [
      { compte: '12000', debit: 1000, tiersType: 'client', tiersId: 'MRC' },
      { compte: '41000', credit: 1000, projet: '23020' },
    ],
  }));
  assert.equal(vente.numeroPiece, 'VTE-2026-000001');
});

// ───────────────────────────────────────────────────────────────────────────
test('une même source ne se passe pas deux fois', async () => {
  const db = await baseNeuve();
  await db.transaction((tx) => gl.passer(tx, achatType('2026-03-15', 'PYBBIL:060449')));
  await assert.rejects(
    () => db.transaction((tx) => gl.passer(tx, achatType('2026-03-16', 'PYBBIL:060449'))),
    /duplicate key|unique/i
  );
});

test('le coût par projet et activité sort du grand livre', async () => {
  const db = await baseNeuve();
  await db.transaction((tx) => gl.passer(tx, achatType()));
  await db.transaction((tx) => gl.passer(tx, {
    exercice: 2026, journal: 'PAI', date: '2026-03-22', utilisateur: U,
    libelle: 'Ventilation paie Employeur D — semaine 12',
    lignes: [
      { compte: '51000', debit: 4200, projet: '23020', activite: '06101' },
      { compte: '21000', credit: 4200 },
    ],
  }));

  const r = await db.query(
    `SELECT code_activite, montant FROM gl.cout_projet
      WHERE code_projet='23020' AND compte_type='charges' ORDER BY code_activite`
  );
  assert.deepEqual(
    r.rows.map((x) => [x.code_activite, Number(x.montant)]),
    [['03530', 1000], ['06101', 4200]]
  );
});

test('l\'assiette des taxes se calcule pour la déclaration', async () => {
  const db = await baseNeuve();
  await db.transaction((tx) => gl.passer(tx, achatType()));
  const r = await db.query(
    `SELECT code_taxe, taxe_payee FROM gl.assiette_taxes ORDER BY code_taxe`
  );
  assert.deepEqual(
    r.rows.map((x) => [x.code_taxe, Number(x.taxe_payee)]),
    [['TPS_CTI', 50], ['TVQ_RTI', 99.75]]
  );
});
