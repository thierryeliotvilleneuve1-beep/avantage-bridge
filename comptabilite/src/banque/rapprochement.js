'use strict';

const gl = require('../grandlivre/ecritures');

/**
 * Rapprochement bancaire : de la transaction Plaid à l'écriture comptable.
 *
 * Deux niveaux d'automatisation, volontairement distincts :
 *
 *   SUGGESTION — une règle reconnaît la transaction et propose une imputation.
 *                Un humain confirme. C'est le mode par défaut.
 *   AUTOMATIQUE — une règle explicitement marquée sûre passe l'écriture seule.
 *                Réservé aux flux répétitifs et sans ambiguïté (loyer, prêt).
 *
 * Le second n'est jamais le défaut. Ces livres sont opposables : quelqu'un doit
 * avoir décidé qu'une machine a le droit d'y écrire sans relecture.
 */

/** Une règle s'applique-t-elle à cette transaction ? Renvoie un score ou null. */
function evaluerRegle(regle, t) {
  let criteres = 0;

  if (regle.compte_id != null) {
    if (regle.compte_id !== t.compte_id) return null;
    criteres++;
  }

  if (regle.motif_description) {
    let re;
    try {
      re = new RegExp(regle.motif_description, 'i');
    } catch (e) {
      return null; // une règle mal écrite ne doit pas faire tomber la synchro
    }
    const cible = `${t.description || ''} ${t.marchand || ''}`;
    if (!re.test(cible)) return null;
    criteres++;
  }

  if (regle.montant_min != null) {
    if (Number(t.montant) < Number(regle.montant_min)) return null;
    criteres++;
  }
  if (regle.montant_max != null) {
    if (Number(t.montant) > Number(regle.montant_max)) return null;
    criteres++;
  }

  // Une règle sans aucun critère attraperait tout : on la considère invalide.
  if (criteres === 0) return null;

  // Plus une règle est spécifique, plus on lui fait confiance.
  return Math.min(0.999, 0.5 + criteres * 0.15);
}

/** Première règle qui correspond, par ordre de priorité. */
function trouverRegle(t, regles) {
  for (const r of regles) {
    const score = evaluerRegle(r, t);
    if (score !== null) return { regle: r, score };
  }
  return null;
}

/**
 * Construit les deux lignes d'écriture d'un mouvement bancaire.
 *
 * Convention de `banque.transaction.montant` : positif = entrée d'argent.
 *   entrée  → l'encaisse augmente : débit banque,      crédit contrepartie
 *   sortie  → l'encaisse diminue  : débit contrepartie, crédit banque
 */
function lignesMouvement(t, compteBanqueGl, imputation) {
  const montant = Math.abs(Number(t.montant));
  const contrepartie = {
    compte: imputation.compteGl,
    libelle: t.marchand || t.description,
    projet: imputation.projet || null,
    activite: imputation.activite || null,
    tiersType: imputation.tiersType || null,
    tiersId: imputation.tiersId || null,
  };
  const banque = { compte: compteBanqueGl, libelle: t.description };

  return Number(t.montant) > 0
    ? [{ ...banque, debit: montant }, { ...contrepartie, credit: montant }]
    : [{ ...contrepartie, debit: montant }, { ...banque, credit: montant }];
}

/**
 * Rapproche une transaction : passe l'écriture et lie les deux.
 * À exécuter dans une transaction ouverte.
 */
async function rapprocher(tx, transactionId, imputation, utilisateur) {
  const r = await tx.query(
    `SELECT t.*, cb.compte_gl, cb.nom AS compte_nom
       FROM banque.transaction t
       JOIN banque.compte_bancaire cb ON cb.id = t.compte_id
      WHERE t.id = $1`,
    [transactionId]
  );
  if (!r.rows.length) throw new Error(`Transaction bancaire ${transactionId} introuvable`);
  const t = r.rows[0];

  if (t.statut === 'rapprochee') {
    throw new Error(`Transaction ${transactionId} déjà rapprochée (écriture ${t.ecriture_id})`);
  }
  if (t.en_attente) {
    throw new Error(
      `Transaction ${transactionId} est encore en attente chez la banque : son montant peut changer`
    );
  }

  const exercice = await tx.query(
    `SELECT id FROM gl.exercice
      WHERE $1::date BETWEEN date_debut AND date_fin AND statut = 'ouvert'`,
    [t.date_transaction]
  );
  if (!exercice.rows.length) {
    throw new Error(`Aucun exercice ouvert ne couvre le ${t.date_transaction}`);
  }

  const ecriture = await gl.passer(tx, {
    exercice: exercice.rows[0].id,
    journal: 'BQ',
    date: t.date_transaction,
    libelle: `${t.compte_nom} — ${t.marchand || t.description}`.slice(0, 200),
    utilisateur,
    sourceType: 'banque',
    sourceId: `banque:${t.id}`,
    lignes: lignesMouvement(t, t.compte_gl, imputation),
  });

  await tx.query(
    `UPDATE banque.transaction
        SET statut='rapprochee', ecriture_id=$2, rapproche_par=$3, rapproche_le=now()
      WHERE id=$1`,
    [transactionId, ecriture.id, utilisateur]
  );

  return ecriture;
}

/**
 * Passe en revue les transactions à traiter d'un compte : attache une
 * suggestion à chacune, et rapproche seule celles dont la règle est marquée
 * automatique.
 */
async function suggererEtAutomatiser(tx, compteId, utilisateur) {
  const regles = (await tx.query(
    `SELECT * FROM banque.regle WHERE actif AND (compte_id IS NULL OR compte_id = $1)
      ORDER BY priorite, id`,
    [compteId]
  )).rows;

  const transactions = (await tx.query(
    `SELECT * FROM banque.transaction
      WHERE compte_id = $1 AND statut = 'a_traiter' AND NOT en_attente
      ORDER BY date_transaction, id`,
    [compteId]
  )).rows;

  const bilan = { examinees: transactions.length, suggerees: 0, automatiques: 0, sans_regle: 0 };

  for (const t of transactions) {
    const trouve = trouverRegle(t, regles);
    if (!trouve) {
      bilan.sans_regle++;
      continue;
    }
    const { regle, score } = trouve;

    await tx.query(
      `UPDATE banque.transaction
          SET statut='suggeree', suggestion_compte=$2, suggestion_projet=$3,
              suggestion_activite=$4, suggestion_regle_id=$5, suggestion_score=$6
        WHERE id=$1`,
      [t.id, regle.compte_gl, regle.code_projet, regle.code_activite, regle.id, score]
    );

    if (regle.automatique) {
      await rapprocher(tx, t.id, {
        compteGl: regle.compte_gl,
        projet: regle.code_projet,
        activite: regle.code_activite,
        tiersType: regle.tiers_type,
        tiersId: regle.tiers_id,
      }, `regle:${regle.id}`);
      bilan.automatiques++;
    } else {
      bilan.suggerees++;
    }
  }

  return bilan;
}

module.exports = { evaluerRegle, trouverRegle, lignesMouvement, rapprocher, suggererEtAutomatiser };
