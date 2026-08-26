'use strict';

/**
 * Normalisation des valeurs Avantage.
 *
 * Avantage sort ses données avec des conventions incohérentes : numéros paddés
 * à des largeurs différentes selon la table, codes d'activité parfois suffixés
 * « .00 », décimales à la virgule ou au point selon la colonne. Toute la
 * fragilité du pont vient de là. Ces fonctions ramènent chaque valeur à une
 * forme canonique unique, une fois, à l'entrée.
 */

/** Code de projet canonique : sans zéros de tête, sans préfixe P. « 0000023020 » → « 23020 ». */
function projet(v) {
  const s = String(v == null ? '' : v).trim().replace(/^[Pp]/, '');
  if (!s) return '';
  const n = s.replace(/[^0-9]/g, '');
  if (!n) return '';
  return String(parseInt(n, 10));
}

/** Code d'activité canonique : 5 chiffres, suffixe « .00 » retiré. « 06100.00 » → « 06100 ». */
function activite(v) {
  const s = String(v == null ? '' : v).trim().replace(/\.00$/, '');
  if (!s) return '';
  const n = s.replace(/[^0-9]/g, '');
  if (!n) return '';
  return n.padStart(5, '0');
}

/**
 * Numéro de commande canonique : 9 chiffres.
 * COMMAN et COMITE le stockent sur 9, PYBBIL sur 7. Sans ce repadding,
 * aucune facture fournisseur ne se raccroche à sa division.
 */
function commande(v) {
  const s = String(v == null ? '' : v).trim().replace(/[^0-9]/g, '');
  if (!s || /^0+$/.test(s)) return '';
  return s.padStart(9, '0');
}

/** Montant canonique : accepte la virgule décimale et les espaces d'affichage. */
function montant(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v == null ? '' : v).trim().replace(/\s| /g, '').replace(',', '.');
  if (!s) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** Arrondi comptable à deux décimales, sans dérive binaire. */
function cents(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Date canonique ISO : « 2025/03/14 » → « 2025-03-14 ». Retourne '' si illisible. */
function date(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const iso = s.replace(/\//g, '-');
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso;
}

/** Texte : trim, espaces compactés. */
function texte(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

module.exports = { projet, activite, commande, montant, cents, date, texte };
