'use strict';

/**
 * Passation d'écritures au grand livre.
 *
 * Le flux suit l'ordre comptable réel, imposé par les triggers de la base :
 *
 *   1. l'en-tête naît en BROUILLON — à ce stade elle peut être déséquilibrée ;
 *   2. les lignes s'ajoutent — seul un brouillon accepte des lignes ;
 *   3. l'en-tête passe à VALIDÉE — le contrôle d'équilibre différé se déclenche
 *      au COMMIT et refuse la transaction entière si débit ≠ crédit.
 *
 * Une fois validée, l'écriture est immuable. On ne la corrige pas : on la
 * contrepasse.
 */

const ERREUR_METIER = 'check_violation';

/** Exécute `fn` dans une transaction. Indispensable : les contrôles d'équilibre
 *  sont différés au COMMIT et n'ont aucun effet hors transaction. */
async function dansTransaction(db, fn) {
  if (typeof db.transaction === 'function') return db.transaction(fn); // PGlite
  const client = await db.connect();                                    // node-postgres
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const centimes = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

/** Trouve la période ouverte qui contient cette date. */
async function periodePour(tx, exerciceId, date) {
  const r = await tx.query(
    `SELECT id, numero, statut FROM gl.periode
      WHERE exercice_id = $1 AND $2::date BETWEEN date_debut AND date_fin
      ORDER BY numero LIMIT 1`,
    [exerciceId, date]
  );
  if (!r.rows.length) {
    throw new Error(`Aucune période de l'exercice ${exerciceId} ne couvre le ${date}`);
  }
  return r.rows[0];
}

/**
 * Passe une écriture complète et la valide.
 *
 * @param {object} tx        transaction ouverte
 * @param {object} e
 * @param {number} e.exercice
 * @param {string} e.journal        code du journal (VTE, ACH, BQ…)
 * @param {string} e.date           'AAAA-MM-JJ'
 * @param {string} e.libelle
 * @param {string} e.utilisateur
 * @param {string} [e.sourceType]   'manuelle' | 'facture_fournisseur' | 'plaid' …
 * @param {string} [e.sourceId]     identifiant côté source — garantit l'idempotence
 * @param {object[]} e.lignes       { compte, debit?, credit?, libelle?, projet?, activite?, taxe?, tiersType?, tiersId? }
 * @returns {Promise<{id:number, numeroPiece:string}>}
 */
async function passer(tx, e) {
  if (!Array.isArray(e.lignes) || e.lignes.length < 2) {
    throw new Error('Une écriture compte au moins deux lignes');
  }

  const periode = await periodePour(tx, e.exercice, e.date);

  const np = await tx.query('SELECT gl.prochain_numero_piece($1, $2) AS numero', [
    e.exercice, e.journal,
  ]);
  const numeroPiece = np.rows[0].numero;

  // 1. En-tête en brouillon.
  const ins = await tx.query(
    `INSERT INTO gl.ecriture
       (exercice_id, periode_id, journal_code, numero_piece, date_ecriture,
        libelle, statut, source_type, source_id, cree_par)
     VALUES ($1,$2,$3,$4,$5,$6,'brouillon',$7,$8,$9)
     RETURNING id`,
    [
      e.exercice, periode.id, e.journal, numeroPiece, e.date,
      e.libelle, e.sourceType || 'manuelle', e.sourceId || null, e.utilisateur,
    ]
  );
  const id = ins.rows[0].id;

  // 2. Lignes.
  let rang = 0;
  for (const l of e.lignes) {
    const debit = centimes(l.debit || 0);
    const credit = centimes(l.credit || 0);
    if (debit === 0 && credit === 0) {
      throw new Error(`Ligne ${rang + 1} : ni débit ni crédit`);
    }
    if (debit !== 0 && credit !== 0) {
      throw new Error(`Ligne ${rang + 1} : débit et crédit sur la même ligne`);
    }
    rang += 1;
    await tx.query(
      `INSERT INTO gl.ligne_ecriture
         (ecriture_id, rang, compte_numero, libelle, montant_debit, montant_credit,
          code_projet, code_activite, code_taxe, tiers_type, tiers_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id, rang, l.compte, l.libelle || null, debit, credit,
        l.projet || null, l.activite || null, l.taxe || null,
        l.tiersType || null, l.tiersId || null,
      ]
    );
  }

  // 3. Validation — déclenche le contrôle d'équilibre au COMMIT.
  await tx.query(
    `UPDATE gl.ecriture SET statut='validee', valide_par=$2, valide_le=now() WHERE id=$1`,
    [id, e.utilisateur]
  );

  return { id, numeroPiece };
}

/**
 * Contrepasse une écriture validée : crée l'écriture miroir qui l'annule.
 *
 * L'originale reste dans les livres — c'est le principe. Un vérificateur doit
 * pouvoir constater qu'une écriture a été passée puis annulée, jamais qu'elle
 * a disparu.
 */
async function contrepasser(tx, ecritureId, { date, motif, utilisateur }) {
  const src = await tx.query(
    `SELECT * FROM gl.ecriture WHERE id = $1`, [ecritureId]
  );
  if (!src.rows.length) throw new Error(`Écriture ${ecritureId} introuvable`);
  const o = src.rows[0];

  if (o.statut === 'brouillon') {
    throw new Error(`Écriture ${o.numero_piece} est un brouillon : supprimez-la, ne la contrepassez pas`);
  }
  if (o.statut === 'contrepassee') {
    throw new Error(`Écriture ${o.numero_piece} est déjà contrepassée`);
  }

  const lignes = await tx.query(
    `SELECT * FROM gl.ligne_ecriture WHERE ecriture_id = $1 ORDER BY rang`, [ecritureId]
  );

  const dateContre = date || new Date().toISOString().slice(0, 10);
  const periode = await periodePour(tx, o.exercice_id, dateContre);

  const np = await tx.query('SELECT gl.prochain_numero_piece($1, $2) AS numero', [
    o.exercice_id, o.journal_code,
  ]);
  const numeroPiece = np.rows[0].numero;

  const ins = await tx.query(
    `INSERT INTO gl.ecriture
       (exercice_id, periode_id, journal_code, numero_piece, date_ecriture,
        libelle, statut, source_type, source_id, contrepasse_id, cree_par)
     VALUES ($1,$2,$3,$4,$5,$6,'brouillon','contrepassation',$7,$8,$9)
     RETURNING id`,
    [
      o.exercice_id, periode.id, o.journal_code, numeroPiece, dateContre,
      `Contrepassation de ${o.numero_piece} — ${motif || 'sans motif'}`,
      `contrepassation:${ecritureId}`, ecritureId, utilisateur,
    ]
  );
  const id = ins.rows[0].id;

  // Débit et crédit inversés, tout le reste conservé.
  for (const l of lignes.rows) {
    await tx.query(
      `INSERT INTO gl.ligne_ecriture
         (ecriture_id, rang, compte_numero, libelle, montant_debit, montant_credit,
          code_projet, code_activite, code_taxe, tiers_type, tiers_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id, l.rang, l.compte_numero, `Contrepassation — ${l.libelle || ''}`.trim(),
        l.montant_credit, l.montant_debit,
        l.code_projet, l.code_activite, l.code_taxe, l.tiers_type, l.tiers_id,
      ]
    );
  }

  await tx.query(
    `UPDATE gl.ecriture SET statut='validee', valide_par=$2, valide_le=now() WHERE id=$1`,
    [id, utilisateur]
  );
  await tx.query(
    `UPDATE gl.ecriture SET statut='contrepassee', contrepassee_par_id=$2 WHERE id=$1`,
    [ecritureId, id]
  );

  return { id, numeroPiece };
}

/** Ouvre un exercice et ses 13 périodes (12 mois + période de clôture). */
async function ouvrirExercice(tx, annee, { debutMois = 1 } = {}) {
  const debut = new Date(Date.UTC(annee, debutMois - 1, 1));
  const fin = new Date(Date.UTC(annee + (debutMois === 1 ? 0 : 1), debutMois - 1 + 12, 0));
  const iso = (d) => d.toISOString().slice(0, 10);

  await tx.query(
    `INSERT INTO gl.exercice (id, date_debut, date_fin) VALUES ($1,$2,$3)`,
    [annee, iso(debut), iso(fin)]
  );

  for (let i = 0; i < 12; i++) {
    const pd = new Date(Date.UTC(debut.getUTCFullYear(), debut.getUTCMonth() + i, 1));
    const pf = new Date(Date.UTC(pd.getUTCFullYear(), pd.getUTCMonth() + 1, 0));
    await tx.query(
      `INSERT INTO gl.periode (exercice_id, numero, date_debut, date_fin) VALUES ($1,$2,$3,$4)`,
      [annee, i + 1, iso(pd), iso(pf)]
    );
  }
  // Période 13 : écritures de fin d'exercice, datées du dernier jour.
  await tx.query(
    `INSERT INTO gl.periode (exercice_id, numero, date_debut, date_fin) VALUES ($1,13,$2,$3)`,
    [annee, iso(fin), iso(fin)]
  );

  return { exercice: annee, debut: iso(debut), fin: iso(fin) };
}

module.exports = {
  dansTransaction, passer, contrepasser, ouvrirExercice, periodePour, ERREUR_METIER,
};
