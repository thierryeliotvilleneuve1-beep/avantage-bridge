// Table de correspondance FOURNISSEURS d'Avantage (code ↔ nom), lue via la passerelle SDK.
// Sert à rapprocher un fournisseur d'un BC Manœuvre avec le fournisseur d'un BC Avantage
// (COMMAN.COMFRN = code fournisseur). LECTURE SEULE.
//
// FOURNI se lit soit par l'alias R01 « FRN », soit en universel R09,FOURNI. On tente R09 d'abord
// (clé maîtresse), puis on retombe sur R01 si besoin. Colonnes par défaut : [0] code, [1] nom —
// ajustables par AVANTAGE_SDK_COL_FRN_CODE / _NOM.

const { interroger, parseCsv, actif } = require('../services/maintcpClient');

const FRN_CODE = parseInt(process.env.AVANTAGE_SDK_COL_FRN_CODE, 10) || 0;
const FRN_NOM = parseInt(process.env.AVANTAGE_SDK_COL_FRN_NOM, 10) || 1;

let _cache = null; // { ts, parCode: Map, parNom: Map }

function normNom(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // enlève les accents
    .replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Lit la table FOURNI (tous les fournisseurs). Renvoie { ok, parCode, parNom, nb }.
async function charger(force) {
  if (!actif()) return { ok: false, raison: 'AVANTAGE_SDK_ACTIF≠true ou identifiants absents' };
  if (_cache && !force && (Date.now() - _cache.ts) < 3600000) return { ok: true, ..._cache, depuis_cache: true };

  // R09 lit toute la table quand on donne un index « large » ; à défaut on tente l'alias R01.
  let r = await interroger({ op: 'R09', mnemonique: 'FOURNI', index: 'FRNO' });
  if (!r.ok) r = await interroger({ op: 'R01', mnemonique: 'FRN', index: 'FRNO' });
  if (!r.ok) return { ok: false, erreur: r.erreur, requete: r.requete };

  const parCode = new Map();
  const parNom = new Map();
  for (const ligne of r.lignes) {
    const c = parseCsv(ligne);
    const code = String(c[FRN_CODE] == null ? '' : c[FRN_CODE]).trim();
    const nom = String(c[FRN_NOM] == null ? '' : c[FRN_NOM]).trim();
    if (!code) continue;
    parCode.set(code, nom);
    const cle = normNom(nom);
    if (cle && !parNom.has(cle)) parNom.set(cle, code);
  }
  _cache = { ts: Date.now(), parCode, parNom };
  return { ok: true, parCode, parNom, nb: parCode.size };
}

// Trouve le code Avantage d'un fournisseur à partir de son nom (rapprochement souple).
// Renvoie { code, nom, methode } ou null. `methode` : 'exact' | 'inclusion' | null.
async function chercherCode(nomFournisseur) {
  const m = await charger();
  if (!m.ok) return null;
  const cible = normNom(nomFournisseur);
  if (!cible) return null;
  // 1) correspondance exacte sur le nom normalisé
  if (m.parNom.has(cible)) { const code = m.parNom.get(cible); return { code, nom: m.parCode.get(code), methode: 'exact' }; }
  // 2) inclusion (le nom Manœuvre est contenu dans un nom Avantage, ou l'inverse) — unique seulement
  const hits = [];
  for (const [cle, code] of m.parNom.entries()) {
    if (cle.includes(cible) || cible.includes(cle)) hits.push({ code, nom: m.parCode.get(code) });
  }
  if (hits.length === 1) return { ...hits[0], methode: 'inclusion' };
  return null; // ambigu ou introuvable → on ne devine pas
}

module.exports = { charger, chercherCode, normNom, actif };
