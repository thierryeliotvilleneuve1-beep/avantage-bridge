// Reconstruit le « Suivi d'un projet » d'Avantage à partir des tables .DBF lisibles :
//   CONPRE  → budget par division (CPMNT), poste GL (CPPOSTE) pour séparer coûts/revenus
//   TRANS   → dépense (journaux P/E/B) et coûts engagés (journal C) par division (TANUM)
//   CONACT  → facturé (CAFACT) et coûts à venir (CAVENIR) par division (CAANUM)
//
// LECTURE SEULE. Aucune écriture. Sert d'abord à un aperçu qu'on compare à l'écran
// Avantage avant de rien pousser dans Manoeuvre.

const fs = require('fs');
const path = require('path');
const dbf = require('../db/lecteurDbf');
const { estCompteRevenu, GL_TAXES } = require('../config/plan-comptable');

function repertoire() {
  if (process.env.AVANTAGE_DBF_DIR) return path.resolve(process.env.AVANTAGE_DBF_DIR);
  return process.platform === 'win32' ? 'A:\\AVA01' : '';
}

// Les en-têtes de CONPRE/CONACT portent des octets parasites après le nom
// (« CPMNT\u0000M… »). On résout donc chaque champ logique par PRÉFIXE sur un nom nettoyé.
function resoudre(meta, prefixes) {
  const map = {};
  const champs = meta.champs.map(c => ({ brut: c.nom, propre: c.nom.replace(/[^A-Za-z0-9]/g, '').toUpperCase() }));
  for (const [logique, pref] of Object.entries(prefixes)) {
    const P = pref.toUpperCase();
    // match exact d'abord, puis préfixe (le plus court gagne pour éviter CPCONUM vs CPCO)
    let hit = champs.find(c => c.propre === P) || champs.find(c => c.propre.startsWith(P));
    map[logique] = hit ? hit.brut : null;
  }
  return map;
}

function fichier(table) { return dbf.trouverFichier(repertoire(), table); }
function num(v) { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : 0; }
function act(v) { return String(v == null ? '' : v).trim().replace(/\.00$/, ''); }
function projMatch(v, code) { const a = parseInt(String(v == null ? '' : v).trim(), 10); return Number.isFinite(a) && a === parseInt(code, 10); }

// CONPRE : budget par division, séparé coûts / revenus selon le poste GL.
function lireBudget(code) {
  const f = fichier('CONPRE'); if (!f) return {};
  const meta = dbf.lireEnTete(f);
  const c = resoudre(meta, { projet: 'CPCONUM', activite: 'CPACT', montant: 'CPMNT', poste: 'CPPOSTE' });
  const div = {};
  dbf.lireTable(f, { meta, filtre: l => {
    if (!projMatch(l[c.projet], code)) return false;
    const a = act(l[c.activite]); if (!a) return false;
    const gl = String(l[c.poste] == null ? '' : l[c.poste]).trim();
    const montant = num(l[c.montant]);
    if (!div[a]) div[a] = { budget_cout: 0, budget_revenu: 0 };
    if (estCompteRevenu(gl)) div[a].budget_revenu += montant; else div[a].budget_cout += montant;
    return false;
  }});
  return div;
}

// TRANS : dépense (P/E/B) et engagé (C) par division. R (produits) et taxes exclus des coûts.
function lireCoutsEngages(code) {
  const f = fichier('TRANS'); if (!f) return {};
  const meta = dbf.lireEnTete(f);
  const c = resoudre(meta, { projet: 'TCONUM', gl: 'TNOGL', montant: 'TMNT', activite: 'TANUM', journal: 'TNOSEQ' });
  const div = {};
  dbf.lireTable(f, { meta, filtre: l => {
    if (!projMatch(l[c.projet], code)) return false;
    const type = String(l[c.journal] || '').trim().charAt(0).toUpperCase();
    const gl = String(l[c.gl] == null ? '' : l[c.gl]).trim();
    if (estCompteRevenu(gl) || GL_TAXES.includes(gl)) return false;
    const a = act(l[c.activite]); if (!a) return false;
    const montant = num(l[c.montant]);
    if (!div[a]) div[a] = { depense: 0, engage: 0, mo: 0 };
    if (type === 'P' || type === 'E' || type === 'B') div[a].depense += montant;
    if (type === 'E') div[a].mo += montant;
    if (type === 'C') div[a].engage += montant;
    return false;
  }});
  return div;
}

// CONACT : facturé et coûts à venir par division (déjà calculés par Avantage).
function lireFactureAvenir(code) {
  const f = fichier('CONACT'); if (!f) return {};
  const meta = dbf.lireEnTete(f);
  const c = resoudre(meta, { projet: 'CACONUM', activite: 'CAANUM', facture: 'CAFACT', avenir: 'CAVENIR', profit: 'CAPROFIT' });
  const div = {};
  dbf.lireTable(f, { meta, filtre: l => {
    if (!projMatch(l[c.projet], code)) return false;
    const a = act(l[c.activite]); if (!a) return false;
    if (!div[a]) div[a] = { facture: 0, avenir: 0, profit: 0 };
    div[a].facture += num(l[c.facture]);
    div[a].avenir += num(l[c.avenir]);
    div[a].profit += num(l[c.profit]);
    return false;
  }});
  return div;
}

// Assemble le contrôle budgétaire d'un projet, par division, comme l'écran « Suivi de projet ».
function apercu(codeRaw) {
  const code = String(codeRaw).replace(/^P/i, '').trim();
  const budget = lireBudget(code);
  const couts = lireCoutsEngages(code);
  const fa = lireFactureAvenir(code);

  const codes = new Set([...Object.keys(budget), ...Object.keys(couts), ...Object.keys(fa)]);
  const divisions = [...codes].sort().map(a => {
    const b = budget[a] || {}, ce = couts[a] || {}, f = fa[a] || {};
    const budget_cout = (b.budget_cout || 0) + (b.budget_revenu || 0); // CONPRE = budget de coûts
    // Revenus budgétés = coûts + profit. Le profit par division est le montant saisi
    // (CONACT.CAPROFIT) s'il existe, sinon le markup standard sur les coûts (défaut 10 %,
    // configurable via AVANTAGE_TAUX_PROFIT). Le taux par contrat vit dans CONTRA, chiffré.
    const profit = (f.profit && f.profit !== 0) ? f.profit : budget_cout * TAUX_PROFIT;
    return {
      division: a,
      budget_cout: r2(budget_cout),
      budget_revenu: r2(budget_cout + profit),
      depense: r2(ce.depense), engage: r2(ce.engage), mo: r2(ce.mo),
      facture: r2(f.facture), a_venir: r2(f.avenir),
    };
  });

  const t = divisions.reduce((s, d) => ({
    budget_cout: s.budget_cout + d.budget_cout, budget_revenu: s.budget_revenu + d.budget_revenu,
    depense: s.depense + d.depense, engage: s.engage + d.engage, mo: s.mo + (d.mo || 0),
    facture: s.facture + d.facture, a_venir: s.a_venir + d.a_venir,
  }), { budget_cout: 0, budget_revenu: 0, depense: 0, engage: 0, mo: 0, facture: 0, a_venir: 0 });

  return { projet: code, divisions, totaux: {
    budget_cout: r2(t.budget_cout), budget_revenu: r2(t.budget_revenu),
    depense: r2(t.depense), engage: r2(t.engage), mo: r2(t.mo), facture: r2(t.facture), a_venir: r2(t.a_venir),
  }};
}

const TAUX_PROFIT = parseFloat(process.env.AVANTAGE_TAUX_PROFIT) || 0.10;
function r2(n) { return Math.round((n || 0) * 100) / 100; }

module.exports = { apercu, lireBudget, lireCoutsEngages, lireFactureAvenir, resoudre };
