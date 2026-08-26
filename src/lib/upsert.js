'use strict';
const b44 = require('./base44');

/** Deux valeurs sont-elles équivalentes du point de vue d'Avantage ? */
function same(a, b) {
  if (typeof a === 'number' || typeof b === 'number') {
    const x = Number(a) || 0;
    const y = Number(b) || 0;
    return Math.abs(x - y) < 0.005; // tolérance au cent
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  return String(a == null ? '' : a) === String(b == null ? '' : b);
}

/**
 * Écrit dans Base44 seulement ce qui a changé, et seulement ce qu'Avantage possède.
 *
 * Deux problèmes que ça règle :
 *
 * 1. DESTRUCTION DE SAISIE HUMAINE. L'ancien code renvoyait un objet complet à
 *    chaque passage, avec `montant_revise: 0`, `prevision_total: 0`,
 *    `directives_travaux: 0`, `travaux_crc: 0`, `credit_admin: 0`,
 *    `asse_caut: 0`, `decompte_crc: 0`. Ces champs ne viennent pas d'Avantage —
 *    ils sont saisis dans Manœuvre. Le cron les remettait à zéro toutes les
 *    15 minutes. Ici, seuls les champs listés dans `champs` sont envoyés ;
 *    tout le reste de la fiche est laissé intact.
 *
 * 2. VOLUME D'ÉCRITURES. Une synchro complète du portefeuille réécrivait tout,
 *    à chaque fois, à 150 ms par ligne. En ne touchant que les lignes réellement
 *    modifiées, une passe sur tous les projets actifs devient tenable.
 *
 * @param {object} o
 * @param {string} o.entity       nom de l'entité Base44
 * @param {object[]} o.rangees    payloads désirés, chacun avec une propriété `_cle`
 * @param {Map} o.existant        Map clé → enregistrement Base44 déjà en place
 * @param {string[]} o.champs     champs possédés par Avantage (les seuls écrits)
 * @param {function} [o.onErreur] rappel(cle, statut, corps)
 */
async function upsertAll({ entity, rangees, existant, champs, onErreur }) {
  const stats = { crees: 0, majs: 0, inchanges: 0, erreurs: 0 };

  for (const rangee of rangees) {
    const cle = rangee._cle;
    const actuel = existant.get(cle);

    // Ne retenir que les champs possédés par Avantage.
    const payload = {};
    for (const f of champs) if (rangee[f] !== undefined) payload[f] = rangee[f];

    if (actuel) {
      const inchange = champs.every((f) => rangee[f] === undefined || same(rangee[f], actuel[f]));
      if (inchange) {
        stats.inchanges++;
        continue;
      }
      payload.sync_avantage_ts = new Date().toISOString();
      const r = await b44.update(entity, b44.idOf(actuel), payload);
      if (r.ok) stats.majs++;
      else {
        stats.erreurs++;
        if (onErreur) onErreur(cle, r.status, r.body);
      }
    } else {
      payload.sync_avantage_ts = new Date().toISOString();
      const r = await b44.create(entity, payload);
      if (r.ok) stats.crees++;
      else {
        stats.erreurs++;
        if (onErreur) onErreur(cle, r.status, r.body);
      }
    }
  }

  return stats;
}

/** Indexe une liste d'enregistrements Base44 par une clé calculée. Signale les doublons. */
function indexer(rows, cleDe) {
  const map = new Map();
  const doublons = [];
  for (const r of rows) {
    const k = cleDe(r);
    if (!k) continue;
    if (map.has(k)) doublons.push({ cle: k, id: b44.idOf(r) });
    else map.set(k, r);
  }
  return { map, doublons };
}

module.exports = { upsertAll, indexer, same };
