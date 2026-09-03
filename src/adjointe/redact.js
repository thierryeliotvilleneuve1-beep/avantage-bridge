// Caviardage — Procedure-Alimentation-Courriels.md §6 : aucun numéro de téléphone
// personnel ne sort vers le vault ou l'interface. Le numéro CRC reste intact.
const { SIGNATURE } = require('./config');

const RE_TEL = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const RE_MONTANT = /\b\d{1,3}(?:[\s ,]\d{3})*(?:[.,]\d{2})?\s?\$|\$\s?\d[\d\s.,]*/g;

function normaliserTel(t) {
  return t.replace(/\D/g, '').replace(/^1/, '');
}

const TEL_CRC = normaliserTel(SIGNATURE.telephone);

// Retire les numéros de téléphone sauf ceux de CRC.
function retirerTelephones(texte) {
  if (!texte) return texte;
  return texte.replace(RE_TEL, (m) => (normaliserTel(m) === TEL_CRC ? m : '[tél. retiré]'));
}

// Retire les montants — un brouillon externe ne porte jamais de donnée financière (§2 des règles opérationnelles).
function retirerMontants(texte) {
  if (!texte) return texte;
  return texte.replace(RE_MONTANT, '[montant retiré]');
}

function contientMontant(texte) {
  RE_MONTANT.lastIndex = 0;
  return RE_MONTANT.test(texte || '');
}

// Caviardage appliqué à tout ce qui est journalisé dans le vault.
function pourVault(texte) {
  return retirerTelephones(texte);
}

module.exports = { retirerTelephones, retirerMontants, contientMontant, pourVault };
