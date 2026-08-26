'use strict';

/**
 * Client Plaid — liaison des comptes bancaires.
 *
 * Trois moments :
 *
 *   1. creerLinkToken()      — le serveur demande un jeton, l'écran ouvre le
 *                              widget Plaid Link avec ce jeton.
 *   2. echangerPublicToken() — le widget renvoie un public_token éphémère ;
 *                              le serveur l'échange contre un access_token
 *                              permanent, qui ne quitte jamais le serveur.
 *   3. synchroniser()        — /transactions/sync, piloté par curseur : Plaid
 *                              ne renvoie que ce qui a changé depuis le dernier
 *                              appel. Rejouable sans créer de doublon.
 *
 * ⚠️  Ce module n'a pas encore été exécuté contre l'API Plaid : il faut des
 *     identifiants Plaid et un compte bancaire relié. La logique de
 *     rapprochement, elle, est testée (voir test/banque.test.mjs).
 */

const ENV = process.env.PLAID_ENV || 'sandbox'; // sandbox | development | production
const HOTES = {
  sandbox: 'sandbox.plaid.com',
  development: 'development.plaid.com',
  production: 'production.plaid.com',
};

async function appel(chemin, corps) {
  const hote = HOTES[ENV];
  if (!hote) throw new Error(`PLAID_ENV inconnu : ${ENV}`);

  const res = await fetch(`https://${hote}${chemin}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
    body: JSON.stringify(corps),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Ne jamais relayer le corps brut : il peut contenir des identifiants.
    const e = new Error(`Plaid ${chemin} → ${data.error_code || res.status} : ${data.error_message || 'erreur'}`);
    e.plaidCode = data.error_code;
    e.httpStatus = res.status;
    throw e;
  }
  return data;
}

/** Jeton à passer au widget Plaid Link côté navigateur. */
async function creerLinkToken({ utilisateurId, langue = 'fr' }) {
  const d = await appel('/link/token/create', {
    client_name: 'Construction Richard Champagne',
    language: langue,
    country_codes: ['CA'],
    products: ['transactions'],
    user: { client_user_id: utilisateurId },
  });
  return d.link_token;
}

/** Échange le public_token du widget contre l'access_token permanent. */
async function echangerPublicToken(publicToken) {
  const d = await appel('/item/public_token/exchange', { public_token: publicToken });
  return { accessToken: d.access_token, itemId: d.item_id };
}

/** Comptes rattachés à un item, pour laisser choisir lequel relier. */
async function listerComptes(accessToken) {
  const d = await appel('/accounts/get', { access_token: accessToken });
  return (d.accounts || []).map((c) => ({
    accountId: c.account_id,
    nom: c.name,
    officiel: c.official_name,
    masque: c.mask,
    type: c.type,
    sousType: c.subtype,
    devise: c.balances && c.balances.iso_currency_code,
  }));
}

/**
 * Récupère les changements depuis le dernier curseur.
 * Renvoie { ajoutees, modifiees, supprimees, curseur }.
 */
async function recupererChangements(accessToken, curseur) {
  const ajoutees = [];
  const modifiees = [];
  const supprimees = [];
  let cur = curseur || null;
  let encore = true;

  while (encore) {
    const d = await appel('/transactions/sync', {
      access_token: accessToken,
      cursor: cur || undefined,
      count: 500,
    });
    ajoutees.push(...(d.added || []));
    modifiees.push(...(d.modified || []));
    supprimees.push(...(d.removed || []));
    cur = d.next_cursor;
    encore = d.has_more;
  }

  return { ajoutees, modifiees, supprimees, curseur: cur };
}

/**
 * Convertit une transaction Plaid en ligne de `banque.transaction`.
 *
 * Plaid compte positivement l'argent qui SORT du compte. On inverse à
 * l'ingestion pour que la convention interne — positif = entrée — soit vraie
 * partout ailleurs dans le système. C'est le genre d'inversion qui, laissée
 * traîner, finit par produire un bilan à l'envers.
 */
function convertir(t) {
  return {
    plaidTransactionId: t.transaction_id,
    dateTransaction: t.date,
    dateAutorisation: t.authorized_date || null,
    description: t.name,
    marchand: t.merchant_name || null,
    montant: -Number(t.amount),
    devise: t.iso_currency_code || 'CAD',
    categoriePlaid: Array.isArray(t.category) ? t.category.join(' / ') : null,
    enAttente: Boolean(t.pending),
  };
}

/**
 * Synchronise un compte bancaire relié : ingère les nouvelles transactions,
 * met à jour celles qui ont changé, retire celles que la banque a annulées.
 * À exécuter dans une transaction ouverte.
 */
async function synchroniser(tx, compteId) {
  const r = await tx.query(
    `SELECT cb.*, pi.access_token
       FROM banque.compte_bancaire cb
       JOIN banque.plaid_item pi ON pi.item_id = cb.plaid_item_id
      WHERE cb.id = $1 AND cb.actif`,
    [compteId]
  );
  if (!r.rows.length) throw new Error(`Compte bancaire ${compteId} introuvable ou inactif`);
  const cb = r.rows[0];

  let changements;
  try {
    changements = await recupererChangements(cb.access_token, cb.plaid_curseur);
  } catch (e) {
    await tx.query(
      `UPDATE banque.compte_bancaire SET plaid_erreur=$2, plaid_derniere_sync=now() WHERE id=$1`,
      [compteId, e.message]
    );
    if (e.plaidCode === 'ITEM_LOGIN_REQUIRED') {
      await tx.query(
        `UPDATE banque.plaid_item SET besoin_reauth=true, derniere_erreur=$2 WHERE item_id=$1`,
        [cb.plaid_item_id, e.message]
      );
    }
    throw e;
  }

  const bilan = { ajoutees: 0, modifiees: 0, supprimees: 0, ignorees: 0 };

  for (const brute of changements.ajoutees) {
    if (brute.account_id !== cb.plaid_account_id) { bilan.ignorees++; continue; }
    const t = convertir(brute);
    const ins = await tx.query(
      `INSERT INTO banque.transaction
         (compte_id, plaid_transaction_id, date_transaction, date_autorisation,
          description, marchand, montant, devise, categorie_plaid, en_attente)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (plaid_transaction_id) DO NOTHING
       RETURNING id`,
      [compteId, t.plaidTransactionId, t.dateTransaction, t.dateAutorisation,
       t.description, t.marchand, t.montant, t.devise, t.categoriePlaid, t.enAttente]
    );
    if (ins.rows.length) bilan.ajoutees++; else bilan.ignorees++;
  }

  // Une transaction déjà rapprochée ne se laisse pas réécrire : son écriture
  // est passée. Un changement de montant après coup exige une contrepassation,
  // décidée par un humain, pas par la synchro.
  for (const brute of changements.modifiees) {
    const t = convertir(brute);
    const up = await tx.query(
      `UPDATE banque.transaction
          SET date_transaction=$2, description=$3, marchand=$4, montant=$5, en_attente=$6
        WHERE plaid_transaction_id=$1 AND statut <> 'rapprochee'
        RETURNING id`,
      [t.plaidTransactionId, t.dateTransaction, t.description, t.marchand, t.montant, t.enAttente]
    );
    if (up.rows.length) bilan.modifiees++; else bilan.ignorees++;
  }

  for (const sup of changements.supprimees) {
    const del = await tx.query(
      `UPDATE banque.transaction SET statut='ignoree'
        WHERE plaid_transaction_id=$1 AND statut <> 'rapprochee' RETURNING id`,
      [sup.transaction_id]
    );
    if (del.rows.length) bilan.supprimees++; else bilan.ignorees++;
  }

  await tx.query(
    `UPDATE banque.compte_bancaire
        SET plaid_curseur=$2, plaid_derniere_sync=now(), plaid_erreur=NULL
      WHERE id=$1`,
    [compteId, changements.curseur]
  );

  return bilan;
}

module.exports = {
  creerLinkToken, echangerPublicToken, listerComptes,
  recupererChangements, convertir, synchroniser,
};
